import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-store.ts';
import { Tasks } from '../src/tasks.ts';

const readTool = { name: 'read_asset', version: '1', description: 'Read a story asset', effect: 'read',
  parameters: { type: 'object', properties: { asset_id: { type: 'string', minLength: 1, maxLength: 128 }, revision: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['asset_id', 'revision'], additionalProperties: false } };
const models = [{ provider: 'deepseek', id: 'test', name: 'Test', auth: 'api_key', context_window: 100000, max_output_tokens: 1000 }];

test('tool sessions require an explicitly configured application binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-tools-'));
  const store = await TaskStore.open(root);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const tasks = new Tasks(store, { send: async () => {} }, () => models);
  await assert.rejects(tasks.createSession('app-a', { system_prompt: 'Use the application tools.', tools: [readTool] }), /tool_version_unavailable/);
});

import { InMemoryCredentialStore, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { TestContext } from 'node:test';
import { AppTools } from '../src/app-tools.ts';
import { createPi } from '../src/pi.ts';
import { piExecutor } from '../src/executor.ts';
import type { CallbackRequest, ToolSnapshot } from '../src/tool-types.ts';
import { initializationTool, initializationReceipt, initializationRef } from './initialization-fixture.ts';
const string = { type: 'string', minLength: 1, maxLength: 65536 };
const chapterTool: ToolSnapshot = { name: 'create_chapter', version: '1', description: 'Create a draft then commit it', effect: 'write', parameters: {
  oneOf: [
    { type: 'object', properties: { mode: { type: 'string', enum: ['draft'] }, title: string, body: string }, required: ['mode', 'title', 'body'], additionalProperties: false },
    { type: 'object', properties: { mode: { type: 'string', enum: ['commit'] }, draft_id: string, draft_revision: string, draft_hash: string }, required: ['mode', 'draft_id', 'draft_revision', 'draft_hash'], additionalProperties: false },
  ],
} };
const hash = 'sha256:' + 'a'.repeat(64);
const scope = { task_id: 'task-1', story_id: 'story-1', source_message_id: 'message-1', operation_id: 'operation-1', authorization_id: 'grant-1' };
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
async function toolFixture(t: TestContext, handler?: (request: CallbackRequest | string) => Promise<Response>, initialization: boolean | ToolSnapshot = false) {
  const root = await mkdtemp(join(tmpdir(), 'mochi-tool-loop-'));
  const store = await TaskStore.open(root);
  const credentials = new InMemoryCredentialStore(); await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'fake-provider-key' }));
  const pi = await createPi(credentials); const model = pi.models().find(m => m.provider === 'deepseek')!;
  const callbacks: CallbackRequest[] = [];
  const definitions: ToolSnapshot[] = [readTool as ToolSnapshot, chapterTool, ...(initialization ? [initialization === true ? initializationTool : initialization] : [])];
  const appTools = new AppTools({ 'app-a': { endpoint: 'https://app.invalid/tools', operations_endpoint: 'https://app.invalid/operations', audience: 'api://write',
    tools: definitions.map(({ name, version, effect }) => ({ name, version, effect })) } }, {
    token: async () => 'test-service-token', fetch: async (url, init) => {
      if (init?.method === 'GET') return handler ? handler(String(url)) : json({ protocol_version: 1, operation_id: scope.operation_id, status: 'not_found' });
      const request = JSON.parse(String(init?.body)) as CallbackRequest; callbacks.push(request);
      // The business callback must never precede its matching durable assistant toolCall and invocation.
      const run = store.runs.get(request.run_id)!;
      assert.ok(run.messages?.some(m => m.message.role === 'assistant' && m.message.content.some(c => c.type === 'toolCall' && c.id === request.tool_call_id)));
      assert.equal(run.invocations?.find(item => item.invocation_id === request.invocation_id)?.status, 'dispatched');
      if (handler) return handler(request);
      const data = request.tool.name === 'read_asset' ? { asset_id: 'a', kind: 'setting', title: 'Setting', revision: '1', content: 'story fact' }
        : request.arguments.mode === 'draft' ? { draft_id: 'draft-1', draft_revision: '1', draft_hash: hash, title: 'Chapter', body: 'Exact draft\n' }
          : { chapter_id: 'chapter-1', revision: '1', content_hash: hash };
      return json({ protocol_version: 1, invocation_id: request.invocation_id, outcome: 'ok', data,
        ...(request.arguments.mode === 'commit' ? { receipt: { operation_id: scope.operation_id, status: 'committed', story_id: scope.story_id, ...data } } : {}) });
    },
  });
  const tasks = new Tasks(store, { send: async () => {} }, pi.models, appTools);
  t.after(async () => { await tasks.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const session = await tasks.createSession('app-a', { system_prompt: 'Use application tools only.', tools: definitions });
  const submit = (extra: Record<string, unknown> = {}) => tasks.submit('app-a', session.session_id,
    { idempotency_key: 'test-run', provider: 'deepseek', model: model.id, prompt: 'Read and create one chapter.', scope, ...extra });
  return { store, tasks, pi, callbacks, appTools, session, submit, executor: piExecutor(pi, appTools) };
}
function respond(t: TestContext, pi: Awaited<ReturnType<typeof createPi>>, turns: (AssistantMessage['content'] | 'length')[], inspect?: (context: string, call: number) => void) {
  let calls = 0;
  t.mock.method(pi.runtime, 'streamSimple', (...[model, context]: Parameters<typeof pi.runtime.streamSimple>) => {
    inspect?.(JSON.stringify(context), calls);
    const content = turns[calls++] ?? [{ type: 'text' as const, text: 'done' }];
    const stream = createAssistantMessageEventStream();
    const reason = content === 'length' ? 'length' : content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop';
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: content === 'length' ? [{ type: 'text', text: 'partial' }] : content, stopReason: reason,
      usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'done', reason, message }); return stream;
  });
  return () => calls;
}
const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage['content'] => [{ type: 'toolCall', id, name, arguments: args }];

test('provider tool projection gives root oneOf an object type without changing the canonical snapshot', async t => {
  const f = await toolFixture(t);
  const snapshot = structuredClone(f.session.tools);
  const snapshotHash = f.session.tool_snapshot_hash;
  const contexts: { tools: { name: string; parameters: Record<string, unknown> }[] }[] = [];
  respond(t, f.pi, [[{ type: 'text', text: 'Discuss only.' }]], context => contexts.push(JSON.parse(context)));
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  assert.equal((await f.tasks.run('app-a', run.run_id)).status, 'succeeded');
  const projected = contexts[0]!.tools.find(tool => tool.name === 'create_chapter')!;
  assert.equal(projected.parameters.type, 'object');
  assert.deepEqual(projected.parameters, { ...chapterTool.parameters, type: 'object' });
  assert.deepEqual(contexts[0]!.tools.find(tool => tool.name === 'read_asset')!.parameters, readTool.parameters);
  const persisted = f.store.sessions.get(f.session.session_id)!;
  assert.deepEqual(persisted.tools, snapshot);
  assert.equal(persisted.tool_snapshot_hash, snapshotHash);
  assert.equal(persisted.tools![1]!.parameters.type, undefined);
});

test('projected oneOf still rejects mixed draft and commit arguments before business callbacks', async t => {
  const f = await toolFixture(t);
  respond(t, f.pi, [
    call('mixed-draft', 'create_chapter', { mode: 'draft', title: 'Chapter', body: 'Body', draft_id: 'not-allowed' }),
    call('mixed-commit', 'create_chapter', { mode: 'commit', draft_id: 'draft-1', draft_revision: '1', draft_hash: hash, body: 'not-allowed' }),
    [{ type: 'text', text: 'Both mixed arguments were rejected.' }],
  ]);
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  assert.equal((await f.tasks.run('app-a', run.run_id)).status, 'succeeded');
  assert.equal(f.callbacks.length, 0);
  const history = await f.tasks.piHistory('app-a', f.session.session_id);
  assert.equal(history.messages.filter(item => item.message.role === 'toolResult' && item.message.isError).length, 2);
  assert.throws(() => f.appTools.validateArguments(chapterTool, { mode: 'draft', title: 'Chapter', body: 'Body', draft_id: 'not-allowed' }), /invalid_arguments/);
  assert.throws(() => f.appTools.validateArguments(chapterTool, { mode: 'commit', draft_id: 'draft-1', draft_revision: '1', draft_hash: hash, body: 'not-allowed' }), /invalid_arguments/);
});

test('real Pi loop persists full tool history before callbacks, emits draft and receipt, sums every model usage', async t => {
  const f = await toolFixture(t);
  const calls = respond(t, f.pi, [call('read-1', 'read_asset', { asset_id: 'a', revision: '1' }),
    call('draft-1', 'create_chapter', { mode: 'draft', title: 'Chapter', body: 'Exact draft\n' }),
    call('commit-1', 'create_chapter', { mode: 'commit', draft_id: 'draft-1', draft_revision: '1', draft_hash: hash }),
    [{ type: 'text', text: 'Saved.' }]], (context, turn) => {
      assert.ok(!context.includes('test-service-token')); assert.ok(!context.includes('fake-provider-key'));
      if (turn === 1) assert.ok(context.includes('story fact'));
      if (turn === 3) assert.ok(context.includes('committed'));
    });
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  const result = await f.tasks.run('app-a', run.run_id);
  assert.equal(result.status, 'succeeded'); assert.equal(calls(), 4);
  assert.equal(result.operations?.[0]?.status, 'committed'); assert.equal(result.artifacts?.[0]?.draft_id, 'draft-1');
  assert.equal(result.usage?.total_tokens, 52); assert.equal(result.usage_complete, true);
  const history = await f.tasks.piHistory('app-a', f.session.session_id);
  assert.equal(history.messages.length, 8); assert.equal(history.messages.filter(m => m.message.role === 'toolResult').length, 3);
  assert.ok((await f.tasks.events('app-a', run.run_id, 0)).events.some(e => e.type === 'operation_updated'));
  assert.ok(!JSON.stringify(f.store.runs.get(run.run_id)).includes('test-service-token'));
  const next = await f.submit({ idempotency_key: 'next-run', scope: { ...scope, task_id: 'task-2', operation_id: 'operation-2' } });
  await f.tasks.execute(next.run_id, f.executor);
  assert.equal((await f.tasks.run('app-a', next.run_id)).status, 'succeeded');
  assert.equal((await f.tasks.piHistory('app-a', f.session.session_id)).messages.length, 10);
});

test('run scope and budgets are immutable and unsupported or invalid tool parameters never reach callback', async t => {
  const f = await toolFixture(t);
  await assert.rejects(f.submit({ scope: { ...scope, endpoint: 'https://attacker.invalid' } }), /invalid_request/);
  await assert.rejects(f.submit({ budget: { max_model_calls: 9 } }), /invalid_request/);
  const run = await f.submit();
  await assert.rejects(f.submit({ scope: { ...scope, story_id: 'other' } }), /idempotency_conflict/);
  respond(t, f.pi, [call('invalid', 'read_asset', { asset_id: 'a' }), [{ type: 'text', text: 'Need an exact revision.' }]]);
  await f.tasks.execute(run.run_id, f.executor);
  assert.equal(f.callbacks.length, 0);
  const history = await f.tasks.piHistory('app-a', f.session.session_id);
  assert.ok(history.messages.some(m => m.message.role === 'toolResult' && m.message.isError));
});

test('formal write budget does not consume drafts and model call limit stops a continuing agent', async t => {
  const f = await toolFixture(t);
  const calls = respond(t, f.pi, [call('draft', 'create_chapter', { mode: 'draft', title: 'Chapter', body: 'Draft only' }),
    call('save', 'create_chapter', { mode: 'commit', draft_id: 'draft-1', draft_revision: '1', draft_hash: hash })]);
  const run = await f.submit({ budget: { max_write_operations: 0 } }); await f.tasks.execute(run.run_id, f.executor);
  assert.equal((await f.tasks.run('app-a', run.run_id)).error, 'write_operation_limit');
  assert.equal(calls(), 2); assert.equal(f.callbacks.length, 1);
  assert.equal((await f.tasks.run('app-a', run.run_id)).artifacts?.length, 1);
});

test('committed callback survives a later model length failure and remains queryable', async t => {
  const f = await toolFixture(t);
  respond(t, f.pi, [call('save', 'create_chapter', { mode: 'commit', draft_id: 'draft-1', draft_revision: '1', draft_hash: hash }), 'length']);
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  const result = await f.tasks.run('app-a', run.run_id);
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'incomplete_output'); assert.equal(result.result, null);
  assert.equal(result.operations?.[0]?.status, 'committed'); assert.equal(result.usage?.total_tokens, 26);
  assert.equal((await f.tasks.history('app-a', f.session.session_id)).messages.length, 0);
  assert.equal((await f.tasks.piHistory('app-a', f.session.session_id)).messages.length, 4);
});

test('lost commit response is reconciled by the original operation without replaying the business callback', async t => {
  let writes = 0; let queries = 0;
  const receipt = { operation_id: scope.operation_id, status: 'committed', story_id: scope.story_id, chapter_id: 'chapter-1', revision: '1', content_hash: hash };
  const f = await toolFixture(t, async request => {
    if (typeof request === 'string') { queries++; return json({ protocol_version: 1, operation_id: scope.operation_id, status: 'committed', receipt }); }
    writes++; throw new Error('connection reset after commit');
  });
  respond(t, f.pi, [call('lost', 'create_chapter', { mode: 'commit', draft_id: 'draft-1', draft_revision: '1', draft_hash: hash }), [{ type: 'text', text: 'Saved.' }]]);
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  assert.equal(writes, 1); assert.equal(queries, 1);
  const result = await f.tasks.run('app-a', run.run_id);
  assert.equal(result.status, 'succeeded'); assert.deepEqual(result.operations?.[0]?.receipt, receipt);
});

test('unknown commit remains failed until authenticated verification and rejects a different-story receipt', async t => {
  let answer: 'not_found' | 'other' | 'correct' = 'not_found'; let writes = 0;
  const f = await toolFixture(t, async request => {
    if (typeof request !== 'string') { writes++; throw new Error('timeout'); }
    if (answer === 'not_found') return json({ protocol_version: 1, operation_id: scope.operation_id, status: 'not_found' });
    return json({ protocol_version: 1, operation_id: scope.operation_id, status: 'committed', receipt: {
      operation_id: scope.operation_id, status: 'committed', story_id: answer === 'other' ? 'different-story' : scope.story_id,
      chapter_id: 'chapter-1', revision: '1', content_hash: hash } });
  });
  const calls = respond(t, f.pi, [call('unknown', 'create_chapter', { mode: 'commit', draft_id: 'draft-1', draft_revision: '1', draft_hash: hash })]);
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  assert.equal(calls(), 1); assert.equal((await f.tasks.run('app-a', run.run_id)).error, 'tool_result_unknown');
  assert.equal((await f.tasks.run('app-a', run.run_id)).operations?.[0]?.status, 'unknown');
  await assert.rejects(f.tasks.verifyOperations('other-app', run.run_id), /forbidden/);
  answer = 'other'; await assert.rejects(f.tasks.verifyOperations('app-a', run.run_id), /tool_transport_failed/);
  assert.equal((await f.tasks.run('app-a', run.run_id)).operations?.[0]?.status, 'unknown');
  answer = 'correct'; const result = await f.tasks.verifyOperations('app-a', run.run_id);
  assert.equal(result.status, 'failed'); assert.equal(result.operations?.[0]?.status, 'committed'); assert.equal(writes, 1);
});

test('model and tool count ceilings stop before another provider or business call', async t => {
  const f = await toolFixture(t);
  const count = respond(t, f.pi, [call('read', 'read_asset', { asset_id: 'a', revision: '1' })]);
  const run = await f.submit({ budget: { max_model_calls: 1 } }); await f.tasks.execute(run.run_id, f.executor);
  assert.equal(count(), 1); assert.equal(f.callbacks.length, 1); assert.equal((await f.tasks.run('app-a', run.run_id)).error, 'model_call_limit');
  const next = await f.submit({ idempotency_key: 'budget-2', budget: { max_tool_calls: 1 } });
  respond(t, f.pi, [[...call('a', 'read_asset', { asset_id: 'a', revision: '1' }), ...call('b', 'read_asset', { asset_id: 'a', revision: '1' })]]);
  await f.tasks.execute(next.run_id, f.executor);
  assert.equal((await f.tasks.run('app-a', next.run_id)).error, 'tool_call_limit'); assert.equal(f.callbacks.length, 1);
});

test('cancelled in-flight commit retains its unknown operation and late verification never changes run status', async t => {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
  const receipt = { operation_id: scope.operation_id, status: 'committed', story_id: scope.story_id, chapter_id: 'chapter-1', revision: '1', content_hash: hash };
  const f = await toolFixture(t, async request => {
    if (typeof request === 'string') return json({ protocol_version: 1, operation_id: scope.operation_id, status: 'committed', receipt });
    enter(); await wait;
    return json({ protocol_version: 1, invocation_id: request.invocation_id, outcome: 'ok', data: {}, receipt });
  });
  respond(t, f.pi, [call('inflight', 'create_chapter', { mode: 'commit', draft_id: 'draft-1', draft_revision: '1', draft_hash: hash })]);
  const run = await f.submit(); const work = f.tasks.execute(run.run_id, f.executor); await entered;
  await f.tasks.cancel('app-a', run.run_id); release(); await work;
  const current = await f.tasks.run('app-a', run.run_id);
  assert.equal(current.status, 'cancelled'); assert.equal(current.result, null); assert.equal(current.operations?.[0]?.status, 'unknown');
  const verified = await f.tasks.verifyOperations('app-a', run.run_id);
  assert.equal(verified.status, 'cancelled'); assert.equal(verified.operations?.[0]?.status, 'committed');
});

test('restart preserves full messages and unresolved dispatch without automatically repeating the model or mutation', async t => {
  const f = await toolFixture(t); const run = await f.submit();
  const saved = structuredClone(f.store.runs.get(run.run_id)!); saved.status = 'running';
  saved.invocations = [{ invocation_id: 'pending', tool_call_id: 'pending-call', name: 'create_chapter', operation_id: scope.operation_id, arguments: { mode: 'commit' }, status: 'dispatched' }];
  await f.store.saveRun(saved); await f.store.close();
  const restored = await TaskStore.open(f.store.root); t.after(() => restored.close());
  const tasks = new Tasks(restored, { send: async () => { throw new Error('unexpected dispatch'); } }, f.pi.models, f.appTools);
  await tasks.recover(); let executed = 0;
  await tasks.execute(run.run_id, async () => { executed++; return { text: 'wrong', usage: null }; });
  const result = await tasks.run('app-a', run.run_id);
  assert.equal(executed, 0); assert.equal(result.status, 'interrupted'); assert.equal(result.operations?.[0]?.status, 'unknown');
  assert.equal(restored.runs.get(run.run_id)?.invocations?.[0]?.status, 'unknown'); await restored.close();
});

test('provider errors do not leak raw exception details through full Pi audit history', async t => {
  const f = await toolFixture(t);
  t.mock.method(f.pi.runtime, 'streamSimple', (...[model]: Parameters<typeof f.pi.runtime.streamSimple>) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: 'error',
      errorMessage: 'upstream-private-token', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'error', reason: 'error', error: message }); return stream;
  });
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  const history = await f.tasks.piHistory('app-a', f.session.session_id);
  assert.ok(!JSON.stringify(history).includes('upstream-private-token'));
  assert.equal((await f.tasks.run('app-a', run.run_id)).status, 'failed');
});

import { createServer } from '../src/server.ts';
import type { AddressInfo } from 'node:net';
import { AccessError } from '../src/auth.ts';

test('HTTP exposes opt-in Pi history and terminal operation verification with application isolation', async t => {
  const f = await toolFixture(t);
  respond(t, f.pi, [[{ type: 'text', text: 'Discuss only.' }]]);
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  const server = createServer({ tasks: f.tasks, authenticate: async value => {
    if (value === 'Bearer app-a') return { appId: 'app-a' };
    if (value === 'Bearer app-b') return { appId: 'app-b' };
    throw new AccessError(401);
  }, isReady: () => true, log: () => {} });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: 'Bearer app-a' };
  const response = await fetch(`${base}/v1/sessions/${f.session.session_id}/history?format=pi-v1`, { headers: auth });
  assert.equal(response.status, 200); assert.equal((await response.json()).format, 'pi-v1');
  const legacy = await fetch(`${base}/v1/sessions/${f.session.session_id}/history`, { headers: auth });
  assert.deepEqual((await legacy.json()).messages.map((m: { role: string }) => m.role), ['user', 'assistant']);
  const verify = await fetch(`${base}/v1/runs/${run.run_id}/operations/verify`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(verify.status, 200); assert.equal((await verify.json()).status, 'succeeded');
  const forbidden = await fetch(`${base}/v1/sessions/${f.session.session_id}/history?format=pi-v1`, { headers: { authorization: 'Bearer app-b' } });
  assert.equal(forbidden.status, 403);
});

test('initialization draft artifacts and both commits survive model failure with unchanged session snapshot', async t => {
  let includeChapter = false;
  const f = await toolFixture(t, async request => {
    assert.notEqual(typeof request, 'string');
    const req = request as CallbackRequest;
    const receipt = { ...initializationReceipt(includeChapter), operation_id: req.scope.operation_id, story_id: req.scope.story_id };
    return json({ protocol_version: 1, invocation_id: req.invocation_id, outcome: 'ok',
      data: req.arguments.mode === 'draft' ? { ...initializationRef, title: 'Story', artifact_kind: 'story_initialization', includes_chapter: includeChapter, assets: [] } : {},
      ...(req.arguments.mode === 'commit' ? { receipt } : {}) });
  }, true);
  const snapshot = structuredClone(f.session.tools); const snapshotHash = f.session.tool_snapshot_hash;
  for (const chapter of [false, true]) {
    includeChapter = chapter;
    respond(t, f.pi, [call('draft', 'initialize_story', { mode: 'draft', title: 'Story', assets: [], ...(chapter ? { chapter: { title: 'First', body: 'Body' } } : {}) }),
      call('commit', 'initialize_story', { mode: 'commit', ...initializationRef }), 'length'], (context, turn) => {
      if (turn === 0) {
        const projected = JSON.parse(context).tools.find((tool: ToolSnapshot) => tool.name === 'initialize_story');
        assert.deepEqual(projected.parameters, { ...initializationTool.parameters, type: 'object' });
      }
    });
    const run = await f.submit({ idempotency_key: 'initialization-' + chapter, scope: { ...scope, task_id: 'task-' + chapter, operation_id: 'op-' + chapter } });
    await f.tasks.execute(run.run_id, f.executor);
    const result = await f.tasks.run('app-a', run.run_id);
    assert.equal(result.error, 'incomplete_output');
    assert.deepEqual(result.artifacts, [{ ...initializationRef, title: 'Story', artifact_kind: 'story_initialization', includes_chapter: chapter }]);
    assert.equal(result.operations?.[0]?.status, 'committed');
    assert.equal((result.operations?.[0]?.receipt as { kind?: string }).kind, chapter ? 'first_chapter_saved' : 'story_initialized');
  }
  assert.deepEqual(f.store.sessions.get(f.session.session_id)?.tools, snapshot);
  assert.equal(f.store.sessions.get(f.session.session_id)?.tool_snapshot_hash, snapshotHash);
});

test('initialization unknown OP verification rejects legacy receipts and a substituted exact draft', async t => {
  let answer: unknown;
  let writes = 0;
  const good = { ...initializationReceipt(true), operation_id: scope.operation_id, story_id: scope.story_id };
  const f = await toolFixture(t, async request => {
    if (typeof request !== 'string') { writes++; throw new Error('lost after commit'); }
    return json(answer ? { protocol_version: 1, operation_id: scope.operation_id, status: 'committed', receipt: answer }
      : { protocol_version: 1, operation_id: scope.operation_id, status: 'not_found' });
  }, true);
  respond(t, f.pi, [call('commit', 'initialize_story', { mode: 'commit', ...initializationRef })]);
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  assert.equal((await f.tasks.run('app-a', run.run_id)).error, 'tool_result_unknown');
  for (const wrong of [{ operation_id: scope.operation_id, story_id: scope.story_id, status: 'committed', chapter_id: 'chapter', revision: '1', content_hash: hash },
    { ...good, draft_id: 'replacement' }, { ...good, draft_revision: '2' }, { ...good, draft_hash: 'sha256:' + 'b'.repeat(64) }, { ...good, story_id: 'other' }]) {
    answer = wrong; await assert.rejects(f.tasks.verifyOperations('app-a', run.run_id), /tool_transport_failed/);
    assert.equal((await f.tasks.run('app-a', run.run_id)).operations?.[0]?.status, 'unknown');
  }
  answer = good;
  const verified = await f.tasks.verifyOperations('app-a', run.run_id);
  assert.equal(verified.status, 'failed'); assert.deepEqual(verified.operations?.[0]?.receipt, good); assert.equal(writes, 1);
});

test('initialization response loss recovers its receipt and refuses a second tool in the same write slot', async t => {
  let writes = 0;
  const receipt = { ...initializationReceipt(), operation_id: scope.operation_id, story_id: scope.story_id };
  const f = await toolFixture(t, async request => {
    if (typeof request === 'string') return json({ protocol_version: 1, operation_id: scope.operation_id, status: 'committed', receipt });
    writes++; throw new Error('lost response');
  }, true);
  respond(t, f.pi, [call('initialize', 'initialize_story', { mode: 'commit', ...initializationRef }),
    call('second', 'create_chapter', { mode: 'commit', draft_id: 'chapter-draft', draft_revision: '1', draft_hash: hash })]);
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  const result = await f.tasks.run('app-a', run.run_id);
  assert.equal(result.error, 'write_operation_limit'); assert.deepEqual(result.operations?.[0]?.receipt, receipt); assert.equal(writes, 1);
});

test('unrecognized registered write commits never bypass a zero formal write budget', async t => {
  const f = await toolFixture(t, async request => {
    assert.notEqual(typeof request, 'string');
    return json({ protocol_version: 1, invocation_id: (request as CallbackRequest).invocation_id, outcome: 'ok', data: {} });
  }, { ...chapterTool, name: 'unrecognized_write' });
  respond(t, f.pi, [call('unknown', 'unrecognized_write', { mode: 'commit', ...initializationRef })]);
  const run = await f.submit({ budget: { max_write_operations: 0 } }); await f.tasks.execute(run.run_id, f.executor);
  assert.equal(f.callbacks.length, 0);
  assert.equal((await f.tasks.run('app-a', run.run_id)).status, 'failed');
});

test('initialization drafts consume no formal write slot and malformed artifact metadata never becomes a draft', async t => {
  let malformed = false;
  const f = await toolFixture(t, async request => {
    const req = request as CallbackRequest;
    return json({ protocol_version: 1, invocation_id: req.invocation_id, outcome: 'ok', data: {
      ...initializationRef, title: 'Story', artifact_kind: 'story_initialization', includes_chapter: malformed } });
  }, true);
  respond(t, f.pi, [call('draft', 'initialize_story', { mode: 'draft', title: 'Story', assets: [] }),
    call('commit', 'initialize_story', { mode: 'commit', ...initializationRef })]);
  const run = await f.submit({ budget: { max_write_operations: 0 } }); await f.tasks.execute(run.run_id, f.executor);
  assert.equal(f.callbacks.length, 1);
  const result = await f.tasks.run('app-a', run.run_id);
  assert.equal(result.artifacts?.length, 1); assert.equal(result.error, 'write_operation_limit'); assert.deepEqual(result.operations, []);
  malformed = true;
  respond(t, f.pi, [call('draft', 'initialize_story', { mode: 'draft', title: 'Story', assets: [] })]);
  const next = await f.submit({ idempotency_key: 'invalid-artifact' }); await f.tasks.execute(next.run_id, f.executor);
  const invalid = await f.tasks.run('app-a', next.run_id);
  assert.equal(invalid.error, 'tool_transport_failed'); assert.deepEqual(invalid.artifacts, []); assert.deepEqual(invalid.operations, []);
});

test('interrupted initialization verifies from persisted tool snapshot over HTTP without replay', async t => {
  const receipt = { ...initializationReceipt(), operation_id: scope.operation_id, story_id: scope.story_id };
  const f = await toolFixture(t, async request => {
    assert.equal(typeof request, 'string');
    return json({ protocol_version: 1, operation_id: scope.operation_id, status: 'committed', receipt });
  }, true);
  const run = await f.submit(); const saved = structuredClone(f.store.runs.get(run.run_id)!); saved.status = 'running';
  saved.invocations = [{ invocation_id: 'pending', tool_call_id: 'pending-call', name: 'initialize_story', operation_id: scope.operation_id,
    arguments: { mode: 'commit', ...initializationRef }, status: 'dispatched' }];
  await f.store.saveRun(saved); await f.store.close();
  const restored = await TaskStore.open(f.store.root); t.after(() => restored.close());
  const tasks = new Tasks(restored, { send: async () => { throw new Error('unexpected dispatch'); } }, f.pi.models, f.appTools);
  await tasks.recover();
  const server = createServer({ tasks, authenticate: async () => ({ appId: 'app-a' }), isReady: () => true, log: () => {} });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/runs/${run.run_id}/operations/verify`,
      { method: 'POST', headers: { authorization: 'Bearer app-a', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'interrupted'); assert.deepEqual(result.operations[0].receipt, receipt); assert.equal(f.callbacks.length, 0);
  } finally { await tasks.close(); await restored.close(); }
});

test('same lifecycle session saves first chapter then uses unchanged create_chapter v1 in its next authorized run', async t => {
  const f = await toolFixture(t, async request => {
    const req = request as CallbackRequest;
    assert.equal(req.app_id, 'app-a'); assert.equal(req.task_id, req.scope.source_message_id.replace('message', 'task'));
    const base = { operation_id: req.scope.operation_id, status: 'committed', story_id: req.scope.story_id };
    const receipt = req.tool.name === 'initialize_story' ? { ...initializationReceipt(true), ...base }
      : { ...base, chapter_id: 'chapter-2', revision: '1', content_hash: hash };
    return json({ protocol_version: 1, invocation_id: req.invocation_id, outcome: 'ok', data: {}, receipt });
  }, true);
  respond(t, f.pi, [call('first', 'initialize_story', { mode: 'commit', ...initializationRef }), [{ type: 'text', text: 'First chapter saved.' }]]);
  const first = await f.submit(); await f.tasks.execute(first.run_id, f.executor);
  assert.equal((await f.tasks.run('app-a', first.run_id)).status, 'succeeded');
  respond(t, f.pi, [call('next', 'create_chapter', { mode: 'commit', draft_id: 'next-draft', draft_revision: '1', draft_hash: hash }), [{ type: 'text', text: 'Second chapter saved.' }]], context => {
    assert.ok(context.includes('first_chapter_saved'));
  });
  const next = await f.submit({ idempotency_key: 'next-chapter', scope: { ...scope, task_id: 'task-2', source_message_id: 'message-2', operation_id: 'operation-2' } });
  await f.tasks.execute(next.run_id, f.executor);
  const result = await f.tasks.run('app-a', next.run_id);
  assert.equal(result.status, 'succeeded'); assert.equal(result.operations?.[0]?.receipt && 'kind' in result.operations[0].receipt, false);
  assert.equal(f.callbacks.length, 2); assert.ok(f.callbacks.every(req => req.session_id === f.session.session_id));
  assert.deepEqual(f.callbacks.map(req => req.run_id), [first.run_id, next.run_id]);
});

test('cancelled initialization retains unknown until exact receipt verification and never rolls back prior work', async t => {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
  const receipt = { ...initializationReceipt(), operation_id: scope.operation_id, story_id: scope.story_id };
  const f = await toolFixture(t, async request => {
    if (typeof request === 'string') return json({ protocol_version: 1, operation_id: scope.operation_id, status: 'committed', receipt });
    enter(); await wait;
    return json({ protocol_version: 1, invocation_id: request.invocation_id, outcome: 'ok', data: {}, receipt });
  }, true);
  respond(t, f.pi, [call('initialize', 'initialize_story', { mode: 'commit', ...initializationRef })]);
  const run = await f.submit(); const work = f.tasks.execute(run.run_id, f.executor); await entered;
  await f.tasks.cancel('app-a', run.run_id); release(); await work;
  assert.equal((await f.tasks.run('app-a', run.run_id)).operations?.[0]?.status, 'unknown');
  const verified = await f.tasks.verifyOperations('app-a', run.run_id);
  assert.equal(verified.status, 'cancelled'); assert.deepEqual(verified.operations?.[0]?.receipt, receipt); assert.equal(f.callbacks.length, 1);
});
