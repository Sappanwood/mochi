import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createServer } from '../src/server.ts';
import { createPi } from '../src/pi.ts';
import { piExecutor } from '../src/executor.ts';
import { TaskStore } from '../src/task-store.ts';
import { Tasks } from '../src/tasks.ts';
import type { ExecutionInput } from '../src/tasks.ts';

test('HTTP session thinking opt-in rejects invalid values and survives restart for subsequent runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-thinking-'));
  let store = await TaskStore.open(root);
  const models = () => [{ provider: 'deepseek', id: 'test', name: 'Test', auth: 'api_key', context_window: 10000, max_output_tokens: 1000 }];
  let tasks = new Tasks(store, { send: async () => {} }, models);
  const server = createServer({ authenticate: async () => ({ appId: 'alpha' }), tasks, isReady: () => true, log: () => {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local-test' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const value of ['ultra', 'OFF', '', null, false, 0, {}, []]) {
    const response = await call('/v1/sessions', { thinking_level: value });
    assert.equal(response.status, 400, JSON.stringify(value));
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  }
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const response = await call('/v1/sessions', { thinking_level: level });
    assert.equal(response.status, 201);
    const created = await response.json() as { session_id: string; thinking_level: string };
    assert.equal(created.thinking_level, level);
    assert.equal((await (await call(`/v1/sessions/${created.session_id}`)).json() as { thinking_level: string }).thinking_level, level);
  }
  const legacyResponse = await call('/v1/sessions', { system_prompt: 'same system' });
  assert.equal(legacyResponse.status, 201);
  const legacy = await legacyResponse.json() as { session_id: string };
  assert.equal(Object.hasOwn(legacy, 'thinking_level'), false);
  const response = await call('/v1/sessions', { system_prompt: 'same system', thinking_level: 'off' });
  assert.equal(response.status, 201);
  const session = await response.json() as { session_id: string; thinking_level: string };
  assert.equal(session.thinking_level, 'off');
  assert.deepEqual(await (await call(`/v1/sessions/${session.session_id}`)).json(), session);
  const input = { idempotency_key: 'before-restart', provider: 'deepseek', model: 'test', prompt: 'first' };
  const submitted = await call(`/v1/sessions/${session.session_id}/runs`, input);
  assert.equal(submitted.status, 202);
  const run = await submitted.json() as { run_id: string };
  assert.equal((await call(`/v1/sessions/${session.session_id}/runs`, { ...input, thinking_level: 'off' })).status, 400);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await store.close(); store = await TaskStore.open(root);
  tasks = new Tasks(store, { send: async () => {} }, models);
  assert.deepEqual(await tasks.session('alpha', session.session_id), session);
  assert.deepEqual(await tasks.session('alpha', legacy.session_id), legacy);
  const observed: unknown[] = [];
  const execute = async (value: ExecutionInput) => {
    observed.push(value.session.thinking_level);
    return { text: 'answer', usage: null };
  };
  await tasks.recover(); await tasks.execute(run.run_id, execute);
  assert.equal((await tasks.submit('alpha', session.session_id, input)).run_id, run.run_id);
  const next = await tasks.submit('alpha', session.session_id, { ...input, idempotency_key: 'after-restart' });
  await tasks.execute(next.run_id, execute);
  const old = await tasks.submit('alpha', legacy.session_id, { ...input, idempotency_key: 'legacy' });
  await tasks.execute(old.run_id, execute);
  assert.deepEqual(observed, ['off', 'off', undefined]);
});

test('real Pi executor projects explicit off to DeepSeek HTTP disabled without changing default no-tool sessions', async t => {
  const requests: Record<string, unknown>[] = [];
  const provider = httpServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: '{"intent":"none"}' }, finish_reason: null }] };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'local-fake-key' }));
  const pi = await createPi(credentials);
  const model = await pi.requireModel('deepseek', 'deepseek-v4-flash');
  t.mock.method(pi, 'requireModel', async () => ({ ...model, baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}` }));
  const stream = pi.runtime.streamSimple.bind(pi.runtime);
  const reasoning: unknown[] = [];
  t.mock.method(pi.runtime, 'streamSimple', (...args: Parameters<typeof pi.runtime.streamSimple>) => {
    reasoning.push(args[2]?.reasoning);
    return stream(...args);
  });
  const now = new Date().toISOString();
  for (const thinking_level of [undefined, 'off', 'low', 'high', 'max', undefined] as const) {
    const input: ExecutionInput = {
      session: { app_id: 'alpha', session_id: 'session', created_at: now, system_prompt: 'same system',
        ...(thinking_level === undefined ? {} : { thinking_level }) },
      run: { app_id: 'alpha', run_id: 'run', session_id: 'session', status: 'running', created_at: now, updated_at: now,
        result: null, error: null, usage: null, dispatched: true, events: [],
        input: { idempotency_key: 'test', provider: 'deepseek', model: model.id, prompt: 'interpret', max_output_tokens: 2048 } },
      history: [{ role: 'user', content: 'previous' }, { role: 'assistant', content: 'answer' }],
    };
    const result = await piExecutor(pi)(input, new AbortController().signal, async () => {});
    assert.equal(result.text, '{"intent":"none"}');
  }
  assert.equal(requests.length, 6);
  assert.deepEqual(requests.map(request => request.thinking), [{ type: 'enabled' }, { type: 'disabled' }, { type: 'enabled' }, { type: 'enabled' }, { type: 'enabled' }, { type: 'enabled' }]);
  assert.deepEqual(reasoning, ['high', undefined, 'low', 'high', 'max', 'high']);
  assert.deepEqual(requests.map(request => request.reasoning_effort), ['high', undefined, 'low', 'high', 'max', 'high']);
  assert.ok(requests.every(request => request.max_tokens === 2048 && request.tools === undefined));
});

test('model catalog publishes only the thinking levels supported by the pinned Pi model', async () => {
  const pi = await createPi(new InMemoryCredentialStore());
  const models = pi.models();
  assert.deepEqual((models.find(m => m.id === 'deepseek-v4-flash') as unknown as { thinking_levels: string[] }).thinking_levels, ['off', 'low', 'high', 'max']);
  assert.deepEqual((models.find(m => m.id === 'deepseek-v4-pro') as unknown as { thinking_levels: string[] }).thinking_levels, ['off', 'high', 'max']);
});
