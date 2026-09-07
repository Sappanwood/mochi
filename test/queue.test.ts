import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueClient } from '@azure/storage-queue';
import { AzureQueue, queueConfig } from '../src/queue.ts';
import type { QueuePort } from '../src/queue.ts';
import { TaskStore } from '../src/task-store.ts';
import { Tasks } from '../src/tasks.ts';

test('queue configuration uses existing account/name/identity contract and rejects credentials or non-Azure targets', () => {
  assert.equal(queueConfig({ MOCHI_QUEUE_ACCOUNT_URL: 'https://mochitest.queue.core.windows.net', MOCHI_QUEUE_NAME: 'mochi-runs' }).url,
    'https://mochitest.queue.core.windows.net/mochi-runs');
  for (const url of ['http://mochitest.queue.core.windows.net', 'https://evil.test', 'https://mochitest.queue.core.windows.net?sig=secret', 'https://mochitest.queue.core.windows.net/path']) {
    assert.throws(() => queueConfig({ MOCHI_QUEUE_ACCOUNT_URL: url, MOCHI_QUEUE_NAME: 'mochi-runs' }));
  }
  assert.throws(() => queueConfig({ MOCHI_QUEUE_ACCOUNT_URL: 'https://mochitest.queue.core.windows.net', MOCHI_QUEUE_NAME: 'bad--queue' }));
});

test('actual Azure Queue SDK sends base64 identity envelope with infinite TTL and no prompt', async () => {
  const seen: { url: string; body: string }[] = [];
  const client = new QueueClient('https://mochitest.queue.core.windows.net/mochi-runs', { getToken: async () => ({ token: 'local-only', expiresOnTimestamp: Date.now() + 60000 }) }, {
    retryOptions: { maxTries: 1 }, httpClient: { async sendRequest(request) {
      seen.push({ url: request.url, body: String(request.body) });
      request.headers.set('content-type', 'application/xml');
      return { request, headers: request.headers, status: 201,
        bodyAsText: '<QueueMessagesList><QueueMessage><MessageId>message</MessageId><InsertionTime>Mon, 07 Sep 2026 00:00:00 GMT</InsertionTime><ExpirationTime>Fri, 31 Dec 9999 23:59:59 GMT</ExpirationTime><PopReceipt>receipt</PopReceipt><TimeNextVisible>Mon, 07 Sep 2026 00:00:00 GMT</TimeNextVisible></QueueMessage></QueueMessagesList>' };
    } },
  });
  await new AzureQueue(client).send('0324b344-38a4-4a12-b45e-19ce030a604e', 'alpha');
  assert.equal(seen.length, 1); assert.ok(seen[0]!.url.includes('messagettl=-1'));
  const encoded = /<MessageText>([^<]+)<\/MessageText>/.exec(seen[0]!.body)![1]!;
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString()), { schema_version: 1, app_id: 'alpha', run_id: '0324b344-38a4-4a12-b45e-19ce030a604e' });
});

test('lease renewal uses newest receipt; duplicates are acknowledged without provider replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-queue-')); const store = await TaskStore.open(root);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const tasks = new Tasks(store, { send: async () => {} }, () => [{ provider: 'deepseek', id: 'test', name: 'Test', auth: 'api_key', context_window: 10000, max_output_tokens: 1000 }]);
  const session = await tasks.createSession('alpha', {});
  const run = await tasks.submit('alpha', session.session_id, { idempotency_key: 'queue', provider: 'deepseek', model: 'test', prompt: 'hello' });
  let renewals = 0; let deletes = 0; let calls = 0;
  const port = {
    receiveMessages: async () => ({ receivedMessageItems: [{ messageId: 'message', popReceipt: 'initial', messageText: Buffer.from(JSON.stringify({ schema_version: 1, app_id: 'alpha', run_id: run.run_id })).toString('base64') }] }),
    updateMessage: async (_id: string, receipt: string) => { assert.equal(receipt, renewals ? `renewed-${renewals}` : 'initial'); return { popReceipt: `renewed-${++renewals}` }; },
    deleteMessage: async (_id: string, receipt: string) => { assert.equal(receipt, deletes ? 'initial' : `renewed-${renewals}`); deletes++; },
    sendMessage: async () => ({}),
  } as unknown as QueuePort;
  const queue = new AzureQueue(port);
  const execute = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { text: 'done', usage: null }; };
  await queue.once(tasks, execute, new AbortController().signal, 2);
  assert.ok(renewals > 0); await queue.once(tasks, execute, new AbortController().signal, 1000);
  assert.equal(calls, 1); assert.equal(deletes, 2);
});

test('lease loss aborts execution and keeps message for interrupted-state deduplication', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-queue-')); const store = await TaskStore.open(root);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const tasks = new Tasks(store, { send: async () => {} }, () => [{ provider: 'deepseek', id: 'test', name: 'Test', auth: 'api_key', context_window: 10000, max_output_tokens: 1000 }]);
  const session = await tasks.createSession('alpha', {});
  const run = await tasks.submit('alpha', session.session_id, { idempotency_key: 'queue', provider: 'deepseek', model: 'test', prompt: 'hello' });
  let deleted = false;
  const port = {
    receiveMessages: async () => ({ receivedMessageItems: [{ messageId: 'message', popReceipt: 'initial', messageText: Buffer.from(JSON.stringify({ schema_version: 1, app_id: 'alpha', run_id: run.run_id })).toString('base64') }] }),
    updateMessage: async () => { throw new Error('lease lost'); }, deleteMessage: async () => { deleted = true; }, sendMessage: async () => ({}),
  } as unknown as QueuePort;
  await assert.rejects(new AzureQueue(port).once(tasks, async (_input, signal) => {
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    return { text: 'must not adopt', usage: null };
  }, new AbortController().signal, 2), /queue_lease_lost/);
  assert.equal(deleted, false); assert.equal((await tasks.run('alpha', run.run_id)).status, 'interrupted');
  assert.equal((await tasks.run('alpha', run.run_id)).result, null);
});

test('real Azure SDK temporary send failure is repaired by runtime outbox and executes once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-outbox-sdk-')); const store = await TaskStore.open(root);
  let sends = 0; let receives = 0; let calls = 0; let payload = '';
  const xmlMessage = (text: string) => `<QueueMessagesList><QueueMessage><MessageId>message</MessageId><InsertionTime>Mon, 07 Sep 2026 00:00:00 GMT</InsertionTime><ExpirationTime>Fri, 31 Dec 9999 23:59:59 GMT</ExpirationTime><PopReceipt>receipt</PopReceipt><TimeNextVisible>Mon, 07 Sep 2026 00:00:00 GMT</TimeNextVisible><DequeueCount>1</DequeueCount><MessageText>${text}</MessageText></QueueMessage></QueueMessagesList>`;
  const client = new QueueClient('https://mochitest.queue.core.windows.net/mochi-runs', { getToken: async () => ({ token: 'local-only', expiresOnTimestamp: Date.now() + 60000 }) }, {
    retryOptions: { maxTries: 1 }, httpClient: { async sendRequest(request) {
      request.headers.set('content-type', 'application/xml');
      if (request.method === 'POST') {
        sends++;
        if (sends === 1) return { request, headers: request.headers, status: 503, bodyAsText: '<Error><Code>ServerBusy</Code><Message>temporary</Message></Error>' };
        payload = /<MessageText>([^<]+)<\/MessageText>/.exec(String(request.body))![1]!;
        return { request, headers: request.headers, status: 201, bodyAsText: xmlMessage('') };
      }
      if (request.method === 'GET') { receives++; return { request, headers: request.headers, status: 200, bodyAsText: xmlMessage(payload) }; }
      return { request, headers: request.headers, status: 204 };
    } },
  });
  const queue = new AzureQueue(client);
  const tasks = new Tasks(store, { send: id => queue.send(id, store.runs.get(id)!.app_id) }, () => [{ provider: 'deepseek', id: 'test', name: 'Test', auth: 'api_key', context_window: 10000, max_output_tokens: 1000 }]);
  t.after(async () => { await tasks.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const session = await tasks.createSession('alpha', {});
  await assert.rejects(tasks.submit('alpha', session.session_id, { idempotency_key: 'sdk-outbox', provider: 'deepseek', model: 'test', prompt: 'private' }), /queue_unavailable/);
  const run = await tasks.byKey('alpha', 'sdk-outbox'); assert.equal(run.status, 'queued');
  await tasks.reconcile();
  const execute = async () => { calls++; return { text: 'done', usage: null }; };
  await queue.once(tasks, execute, new AbortController().signal);
  await tasks.reconcile(); await queue.once(tasks, execute, new AbortController().signal);
  assert.equal(sends, 2); assert.equal(receives, 2); assert.equal(calls, 1);
  assert.equal((await tasks.run('alpha', run.run_id)).status, 'succeeded');
});
