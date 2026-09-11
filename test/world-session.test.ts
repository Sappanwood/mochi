import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppTools, stable } from '../src/app-tools.ts';
import { TaskStore } from '../src/task-store.ts';
import { Tasks } from '../src/tasks.ts';
import { tools, worldTools, worldScope, scope, receipt, draft, json } from './free-session-fixture.ts';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mochi-world-')); const store = await TaskStore.open(root);
  let response: unknown;
  const allowed = [...tools, worldTools[5]!, worldTools[10]!].map(({ name, version, effect }) => ({ name, version, effect }));
  const appTools = new AppTools({ write: { endpoint: 'https://write.invalid/tools', operations_endpoint: 'https://write.invalid/operations', audience: 'api://write', tools: allowed } },
    { token: async () => 'fake', fetch: async () => json(response) });
  const tasks = new Tasks(store, { send: async () => {} }, () => [{ provider: 'deepseek', id: 'test', name: 'Test', auth: 'api_key', context_window: 100000, max_output_tokens: 1000 }], appTools);
  t.after(async () => { await tasks.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { tasks, appTools, set: (v: unknown) => { response = v; } };
}
test('world session uses exact eleven-tool snapshot while legacy hash and capabilities stay fixed', async t => {
  const f = await fixture(t);
  const old = await f.tasks.createSession('write', { tool_protocol_version: 2, system_prompt: 'Old', tools });
  const before = stable(await f.tasks.session('write', old.session_id));
  const fresh = await f.tasks.createSession('write', { tool_protocol_version: 2, system_prompt: 'World', tools: worldTools });
  assert.equal(fresh.tools?.length, 11); assert.notEqual(old.tool_snapshot_hash, fresh.tool_snapshot_hash);
  const input = { idempotency_key: 'world', provider: 'deepseek', model: 'test', prompt: 'Save a world', scope: worldScope };
  await assert.rejects(f.tasks.submit('write', old.session_id, input), /invalid_request/);
  const run = await f.tasks.submit('write', fresh.session_id, input);
  assert.equal((await f.tasks.submit('write', fresh.session_id, input)).run_id, run.run_id);
  await assert.rejects(f.tasks.submit('write', fresh.session_id, { ...input, scope: { ...worldScope, target: { kind: 'world', asset_id: 'other' } } }), /idempotency_conflict/);
  assert.equal(stable(await f.tasks.session('write', old.session_id)), before);
  for (const invalid of [worldTools.slice(0, 10), [...tools, worldTools[10]!], [...worldTools].reverse(), worldTools.map(x => x.name === 'save_world' ? { ...x, effect: 'read' } : x)])
    await assert.rejects(f.tasks.createSession('write', { tool_protocol_version: 2, system_prompt: 'Mixed', tools: invalid }));
  await assert.rejects(f.tasks.createSession('write', { system_prompt: 'Missing protocol', tools: worldTools }));
});
test('world new and update receipts bind exact tool, action, target, and candidate during callback and recovery', async t => {
  const f = await fixture(t);
  for (const action of ['create_world', 'update_world']) {
    const s = { ...worldScope, action }; const { task_id, ...callbackScope } = s;
    const request = { protocol_version: 2, app_id: 'write', session_id: 's', run_id: 'r', task_id, scope: callbackScope,
      invocation_id: 'i', tool_call_id: 'tc', tool: { name: 'save_world', version: '2' }, arguments: { mode: 'commit', ...draft } };
    const saved = { ...receipt(), kind: action === 'create_world' ? 'world_created' : 'world_updated', target: s.target };
    const binding = { tool: request.tool, scope: s, arguments: request.arguments };
    f.set({ protocol_version: 2, invocation_id: 'i', outcome: 'ok', data: {}, receipt: saved });
    assert.equal((await f.appTools.invoke('write', request as never, new AbortController().signal)).outcome, 'ok');
    f.set({ protocol_version: 2, operation_id: 'op', status: 'committed', receipt: saved });
    assert.equal((await f.appTools.operation('write', 'op', new AbortController().signal, binding as never)).status, 'committed');
    for (const wrong of [{ ...saved, kind: 'character_created' }, { ...saved, target: scope.target }, { ...saved, draft_id: 'other' }, { ...saved, assets: [] }]) {
      f.set({ protocol_version: 2, operation_id: 'op', status: 'committed', receipt: wrong });
      await assert.rejects(f.appTools.operation('write', 'op', new AbortController().signal, binding as never), /tool_transport_failed/);
    }
  }
});
