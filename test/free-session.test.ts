import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppTools } from '../src/app-tools.ts';
import { TaskStore } from '../src/task-store.ts';
import { Tasks } from '../src/tasks.ts';
import { tools, scope, receipt, draft, hash, json } from './free-session-fixture.ts';
const models = [{ provider: 'deepseek', id: 'test', name: 'Test', auth: 'api_key', context_window: 100000, max_output_tokens: 1000 }];
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mochi-free-')); const store = await TaskStore.open(root);
  let response: unknown;
  const binding = { endpoint: 'https://write.invalid/tools', operations_endpoint: 'https://write.invalid/operations', audience: 'api://write',
    tools: tools.map(({ name, version, effect }) => ({ name, version, effect })) };
  const appTools = new AppTools({ write: binding }, { token: async () => 'fake', fetch: async () => json(response) });
  const tasks = new Tasks(store, { send: async () => {} }, () => models, appTools);
  t.after(async () => { await tasks.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { tasks, store, appTools, binding, setResponse: (value: unknown) => { response = value; } };
}
test('v2 requires its full ordered ten-tool snapshot and v1/v2 bindings coexist', async t => {
  const f = await fixture(t);
  assert.doesNotThrow(() => new AppTools({ write: { ...f.binding, tools: [...f.binding.tools, { name: 'create_chapter', version: '1', effect: 'write' }] } }));
  const session = await f.tasks.createSession('write', { tool_protocol_version: 2, system_prompt: 'Free session', tools });
  assert.equal(session.tool_protocol_version, 2);
  for (const invalid of [tools.slice(1), [...tools].reverse(), [], [...tools, tools[0]], tools.map(x => x.name === 'read_asset' ? { ...x, version: '1' } : x)])
    await assert.rejects(f.tasks.createSession('write', { tool_protocol_version: 2, system_prompt: 'Free', tools: invalid }));
  await assert.rejects(f.tasks.createSession('write', { system_prompt: 'Mixed', tools }));
});
test('v2 scope and preview digest are immutable, strict, and never mixed into v1', async t => {
  const f = await fixture(t); const session = await f.tasks.createSession('write', { tool_protocol_version: 2, system_prompt: 'Free', tools });
  const input = { idempotency_key: 'task:execute:1', provider: 'deepseek', model: 'test', prompt: 'Original message', scope, draft_context_digest: hash };
  const run = await f.tasks.submit('write', session.session_id, input);
  assert.equal((await f.tasks.submit('write', session.session_id, structuredClone(input))).run_id, run.run_id);
  for (const changed of [{ ...scope, refs_digest: 'sha256:' + 'b'.repeat(64) }, { ...scope, target: { kind: 'character', asset_id: 'other' } }])
    await assert.rejects(f.tasks.submit('write', session.session_id, { ...input, scope: changed }), /idempotency_conflict/);
  await assert.rejects(f.tasks.submit('write', session.session_id, { ...input, draft_context_digest: 'sha256:' + 'b'.repeat(64) }), /idempotency_conflict/);
  for (const invalid of [{ ...scope, story_id: 'old' }, { ...scope, phase: 'resolve' }, { ...scope, action: 'anything' }, { ...scope, target: { kind: 'story', story_id: 'story' } }, { ...scope, authorization_id: null }, { ...scope, binding_digest: undefined }])
    await assert.rejects(f.tasks.submit('write', session.session_id, { ...input, scope: invalid }), /invalid_request/);
});
test('v2 callbacks and operation verification strictly bind action, target and exact draft', async t => {
  const f = await fixture(t); const { task_id, ...callbackScope } = scope;
  const request = { protocol_version: 2, app_id: 'write', session_id: 's', run_id: 'r', task_id, scope: callbackScope,
    invocation_id: 'i', tool_call_id: 'tc', tool: { name: 'save_character', version: '2' }, arguments: { mode: 'commit', ...draft } };
  const ok = receipt(); f.setResponse({ protocol_version: 2, invocation_id: 'i', outcome: 'ok', data: {}, receipt: ok });
  const result = await f.appTools.invoke('write', request as never, new AbortController().signal);
  assert.equal(result.outcome, 'ok'); if (result.outcome === 'ok') assert.deepEqual(result.receipt, ok);
  for (const wrong of [{ ...ok, kind: 'character_updated' }, { ...ok, target: { kind: 'character', asset_id: 'other' } }, { ...ok, draft_id: 'other' }, { ...ok, task_id: 'other' }, { ...ok, assets: [] }, { ...ok, protocol_version: 1 }]) {
    f.setResponse({ protocol_version: 2, invocation_id: 'i', outcome: 'ok', data: {}, receipt: wrong });
    await assert.rejects(f.appTools.invoke('write', request as never, new AbortController().signal), /tool_transport_failed/);
    f.setResponse({ protocol_version: 2, operation_id: 'op', status: 'committed', receipt: wrong });
    await assert.rejects(f.appTools.operation('write', 'op', new AbortController().signal, { tool: request.tool, scope, arguments: request.arguments } as never), /tool_transport_failed/);
  }
});
test('initialization-only and first-chapter actions accept only their exact receipt branch', async t => {
  const f = await fixture(t);
  for (const [action, kind] of [['initialize_story', 'story_initialized'], ['save_first_chapter', 'first_chapter_saved'], ['create_chapter', 'chapter_created']] as const) {
    const s = { ...scope, action, target: { kind: 'story', story_id: 'story' } };
    const value = { ...receipt(), kind, target: s.target, ...(kind !== 'chapter_created' ? { assets: [] } : {}),
      ...(kind !== 'story_initialized' ? { chapter: { chapter_id: 'chapter', revision: '1', content_hash: hash } } : {}) };
    const binding = { scope: s, tool: { name: action === 'create_chapter' ? 'create_chapter' : 'initialize_story', version: '2' }, arguments: { mode: 'commit', ...draft } };
    f.setResponse({ protocol_version: 2, operation_id: 'op', status: 'committed', receipt: value });
    assert.equal((await f.appTools.operation('write', 'op', new AbortController().signal, binding as never)).status, 'committed');
    for (const wrong of [{ ...value, kind: 'character_created' }, { ...value, kind: kind === 'story_initialized' ? 'first_chapter_saved' : 'story_initialized' },
      { ...value, draft_hash: 'sha256:' + 'b'.repeat(64) }, { ...value, target: { kind: 'story', story_id: 'wrong' } }, { ...value, task_id: 'wrong' }]) {
      f.setResponse({ protocol_version: 2, operation_id: 'op', status: 'committed', receipt: wrong });
      await assert.rejects(f.appTools.operation('write', 'op', new AbortController().signal, binding as never), /tool_transport_failed/);
    }
  }
});
test('v2 schemas accept thirty bounded genres while legacy schema ceilings stay unchanged', async t => {
  const f = await fixture(t); const revised = structuredClone(tools);
  revised[7]!.parameters = { type: 'object', properties: { genres: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 128 } } }, required: ['genres'], additionalProperties: false };
  assert.ok(await f.tasks.createSession('write', { tool_protocol_version: 2, system_prompt: 'Free', tools: revised }));
  assert.throws(() => f.appTools.validate('write', [{ ...revised[7]!, version: '1' }]), /invalid_request/);
});
test('v2 terminal OP states are explicit and never accept a hidden receipt', async t => {
  const f = await fixture(t); const binding = { scope, tool: { name: 'save_character', version: '2' }, arguments: { mode: 'commit', ...draft } };
  for (const status of ['unknown', 'revoked', 'conflict']) {
    f.setResponse({ protocol_version: 2, operation_id: 'op', status });
    assert.equal((await f.appTools.operation('write', 'op', new AbortController().signal, binding as never)).status, status);
    f.setResponse({ protocol_version: 2, operation_id: 'op', status, receipt: receipt() });
    await assert.rejects(f.appTools.operation('write', 'op', new AbortController().signal, binding as never), /tool_transport_failed/);
  }
});
test('process interruption conservatively consumes the v2 run time ceiling', async t => {
  const f = await fixture(t); const session = await f.tasks.createSession('write', { tool_protocol_version: 2, system_prompt: 'Free', tools });
  const run = await f.tasks.submit('write', session.session_id, { idempotency_key: 'interrupted', provider: 'deepseek', model: 'test', prompt: 'Resolve',
    scope: { protocol_version: 2, conversation_id: 'c', task_id: 't', source_message_id: 'm', operation_id: 'o', refs_digest: hash, phase: 'resolve' }, budget: { max_write_operations: 0 } });
  const stored = structuredClone(f.store.runs.get(run.run_id)!); stored.status = 'running'; stored.execution_started_at = new Date().toISOString();
  await f.store.saveRun(stored); await f.tasks.recover();
  assert.equal((await f.tasks.run('write', run.run_id)).execution_usage?.duration_ms, 300000);
});
