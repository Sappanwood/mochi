import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createPi, openConversation } from '../src/pi.ts';
import { piExecutor } from '../src/executor.ts';
import { AppTools } from '../src/app-tools.ts';
import { TaskStore } from '../src/task-store.ts';
import { Tasks } from '../src/tasks.ts';
import { tools, worldTools, worldScope, scope, receipt, draft, hash, json } from './free-session-fixture.ts';
import type { CallbackRequest } from '../src/tool-types.ts';
const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage['content'] => [{ type: 'toolCall', id, name, arguments: args }];
const commit = { mode: 'commit', ...draft };
async function fixture(t: TestContext, world = false) {
  const selectedTools = world ? worldTools : tools;
  const root = await mkdtemp(join(tmpdir(), 'mochi-free-pi-')); const store = await TaskStore.open(root);
  const credentials = new InMemoryCredentialStore(); await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'fake' }));
  const pi = await createPi(credentials); const model = pi.models().find(m => m.provider === 'deepseek')!;
  const callbacks: CallbackRequest[] = []; let lost = false; let forged = false; let queries = 0; let candidates = 0;
  let saved: Record<string, unknown> | undefined; let rejectDraft = false;
  const appTools = new AppTools({ write: { endpoint: 'https://write.invalid/tools', operations_endpoint: 'https://write.invalid/operations', audience: 'api://write',
    tools: selectedTools.map(({ name, version, effect }) => ({ name, version, effect })) } }, { token: async () => 'fake', fetch: async (url, init) => {
      if (init?.method === 'GET') { queries++; return json({ protocol_version: 2, operation_id: decodeURIComponent(String(url).split('/').at(-1)!), status: saved ? 'committed' : 'unknown',
        ...(saved ? { receipt: forged ? { ...saved, draft_id: 'forged' } : saved } : {}) }); }
      const request = JSON.parse(String(init?.body)) as CallbackRequest; callbacks.push(request);
      if (request.arguments.mode === 'commit') {
        saved = { ...receipt(), operation_id: request.scope.operation_id, task_id: request.task_id,
          target: 'target' in request.scope ? request.scope.target : undefined,
          kind: request.tool.name === 'save_world' ? ('action' in request.scope && request.scope.action === 'update_world' ? 'world_updated' : 'world_created') : request.tool.name === 'save_character' ? 'character_created' : request.tool.name === 'initialize_story' ? 'story_initialized' : 'chapter_created',
          ...(request.tool.name === 'initialize_story' ? { assets: [] } : {}),
          ...(request.tool.name === 'create_chapter' ? { chapter: { chapter_id: 'chapter', revision: '1', content_hash: hash } } : {}) };
        if (lost) throw new Error('lost response');
        return json({ protocol_version: 2, invocation_id: request.invocation_id, outcome: 'ok', data: {}, receipt: saved });
      }
      if (request.arguments.mode === 'draft' && rejectDraft) { rejectDraft = false; return json({ protocol_version: 2, invocation_id: request.invocation_id, outcome: 'error', error: { code: 'invalid_arguments', retryable: false } }); }
      const data = request.arguments.mode === 'draft' ? { ...draft, draft_id: 'draft-' + ++candidates, group_id: 'group-' + candidates, ordinal: 1, title: 'Candidate',
        artifact_kind: request.tool.name === 'save_world' ? 'world' : request.tool.name === 'save_character' ? 'character' : request.tool.name === 'initialize_story' ? 'story_initialization' : 'chapter' } : { content: 'fixed reference' };
      return json({ protocol_version: 2, invocation_id: request.invocation_id, outcome: 'ok', data });
    } });
  const tasks = new Tasks(store, { send: async () => {} }, pi.models, appTools); let sessionsOpened = 0;
  const executor = piExecutor(pi, appTools, async input => { sessionsOpened++; return openConversation(pi, input); });
  t.after(async () => { await tasks.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const session = await tasks.createSession('write', { tool_protocol_version: 2, system_prompt: 'Free conversation.', tools: selectedTools });
  const submit = (s: Record<string, unknown> = scope, extra: Record<string, unknown> = {}) => tasks.submit('write', session.session_id,
    { idempotency_key: `${s.task_id}:${s.phase}:1`, provider: 'deepseek', model: model.id, prompt: 'Original message', scope: s, ...extra });
  let turns: (AssistantMessage['content'] | 'length')[] = []; let count = 0; const contexts: unknown[] = [];
  t.mock.method(pi.runtime, 'streamSimple', (...[m, context]: Parameters<typeof pi.runtime.streamSimple>) => {
    contexts.push(JSON.parse(JSON.stringify(context))); count++;
    const next = turns.shift() ?? [{ type: 'text' as const, text: 'Done.' }];
    const content = next === 'length' ? [{ type: 'text' as const, text: 'partial' }] : next;
    const reason = next === 'length' ? 'length' : content.some(p => p.type === 'toolCall') ? 'toolUse' : 'stop';
    const message: AssistantMessage = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), content, stopReason: reason,
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason, message }); return stream;
  });
  return { tasks, store, root, appTools, executor, session, submit, callbacks, contexts, pi, count: () => count, opened: () => sessionsOpened,
    rejectDraft: () => { rejectDraft = true; },
    respond: (...next: (AssistantMessage['content'] | 'length')[]) => { turns = next; }, lose: () => { lost = true; }, forge: (v: boolean) => { forged = v; }, queries: () => queries };
}
const resolveScope = { protocol_version: 2, conversation_id: 'conversation', task_id: 'task', source_message_id: 'message', operation_id: 'op', phase: 'resolve', refs_digest: hash };
test('real Pi v2 preserves one live AgentSession across character, initialization and chapter runs with multiple candidates', async t => {
  const f = await fixture(t);
  f.respond(call('d1', 'save_character', { mode: 'draft', title: 'A', body: 'A' }), call('d2', 'save_character', { mode: 'draft', title: 'B', body: 'B' }), call('save', 'save_character', commit));
  const first = await f.submit(); await f.tasks.execute(first.run_id, f.executor);
  assert.equal((await f.tasks.run('write', first.run_id)).status, 'succeeded');
  assert.equal((await f.tasks.run('write', first.run_id)).artifacts?.length, 2);
  for (const [i, tool, action] of [[2, 'initialize_story', 'initialize_story'], [3, 'create_chapter', 'create_chapter'], [4, 'save_character', 'create_character']] as const) {
    f.respond(call('save-' + i, tool, commit));
    const next = await f.submit({ ...scope, task_id: 'task-' + i, source_message_id: 'message-' + i, operation_id: 'op-' + i,
      action, target: i === 4 ? scope.target : { kind: 'story', story_id: 'story' } });
    await f.tasks.execute(next.run_id, f.executor); assert.equal((await f.tasks.run('write', next.run_id)).status, 'succeeded');
  }
  assert.equal(f.opened(), 1);
  assert.equal((await f.tasks.piHistory('write', f.session.session_id)).messages.filter(x => x.message.role === 'user').length, 4);
  assert.ok(JSON.stringify(f.contexts.at(-1)).includes('group-1'));
});
test('resolve is readonly, execute continues the same source without a second user message and shares remaining task budget', async t => {
  const f = await fixture(t); f.respond(call('read', 'search_library', {}));
  const first = await f.submit(resolveScope, { budget: { max_write_operations: 0 } }); await f.tasks.execute(first.run_id, f.executor);
  f.respond(call('draft', 'save_character', { mode: 'draft', title: 'A', body: 'A' }));
  const next = await f.submit(scope); await f.tasks.execute(next.run_id, f.executor);
  assert.equal((await f.tasks.run('write', next.run_id)).status, 'succeeded');
  assert.equal(f.opened(), 1);
  const history = await f.tasks.piHistory('write', f.session.session_id);
  assert.equal(history.messages.filter(x => x.message.role === 'user').length, 1);
  assert.equal((await f.tasks.history('write', f.session.session_id)).messages.filter(x => x.role === 'user').length, 1);
  assert.ok(history.messages.some(x => x.message.role === 'custom'));
  assert.equal(f.store.runs.get(next.run_id)?.input.budget?.max_model_calls, 6);
  await assert.rejects(f.submit(scope, { idempotency_key: 'third' }), /task_phase_conflict/);
});
test('readonly resolve rejects draft; cancelled resolve cannot bind; unbound preview cannot commit', async t => {
  const f = await fixture(t); f.respond(call('write', 'save_character', { mode: 'draft', title: 'A', body: 'A' }));
  const first = await f.submit(resolveScope, { budget: { max_write_operations: 0 } }); await f.tasks.execute(first.run_id, f.executor);
  assert.equal(f.callbacks.length, 0); assert.equal((await f.tasks.run('write', first.run_id)).error, 'forbidden_scope');
  await assert.rejects(f.submit(scope), /task_phase_conflict/);
  const cancelled = await f.submit({ ...resolveScope, task_id: 'cancelled' }, { budget: { max_write_operations: 0 } }); await f.tasks.cancel('write', cancelled.run_id);
  await assert.rejects(f.submit({ ...scope, task_id: 'cancelled' }), /task_phase_conflict/);
  f.respond(call('commit', 'save_character', commit));
  const preview = await f.submit({ ...resolveScope, task_id: 'preview', phase: 'execute' }, { draft_context_digest: hash }); await f.tasks.execute(preview.run_id, f.executor);
  assert.equal(f.callbacks.length, 0); assert.equal((await f.tasks.run('write', preview.run_id)).error, 'authorization_required');
});
test('v2 unknown commit rejects forged recovery, preserves original receipt after verification and model failure', async t => {
  const f = await fixture(t); f.lose(); f.forge(true); f.respond(call('save', 'save_character', commit));
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  assert.equal((await f.tasks.run('write', run.run_id)).error, 'tool_result_unknown');
  await assert.rejects(f.tasks.verifyOperations('write', run.run_id), /tool_transport_failed/);
  f.forge(false); const recovered = await f.tasks.verifyOperations('write', run.run_id);
  assert.equal(recovered.operations?.[0]?.status, 'committed'); assert.equal(recovered.status, 'failed'); assert.equal(f.callbacks.length, 1);
});
test('phase retries recover the original runs even after continuation, and changed scope cannot use a fresh key', async t => {
  const f = await fixture(t);
  const first = await f.submit(resolveScope, { budget: { max_write_operations: 0, max_model_calls: 1 } }); await f.tasks.execute(first.run_id, f.executor);
  const next = await f.submit(scope); await f.tasks.execute(next.run_id, f.executor);
  assert.equal((await f.tasks.run('write', next.run_id)).status, 'succeeded');
  assert.equal((await f.submit(resolveScope, { budget: { max_write_operations: 0, max_model_calls: 1 } })).run_id, first.run_id);
  assert.equal((await f.submit(scope)).run_id, next.run_id);
  await assert.rejects(f.submit({ ...scope, refs_digest: 'sha256:' + 'b'.repeat(64) }, { idempotency_key: 'new-key' }), /task_phase_conflict/);
  assert.equal(f.count(), 2);
});
test('eight model calls exhaust the shared task budget before execute is queued', async t => {
  const f = await fixture(t); f.respond(...Array.from({ length: 7 }, (_, i) => call('read-' + i, 'search_library', {})));
  const first = await f.submit(resolveScope, { budget: { max_write_operations: 0 } }); await f.tasks.execute(first.run_id, f.executor);
  assert.equal((await f.tasks.run('write', first.run_id)).status, 'succeeded'); assert.equal(f.count(), 8);
  await assert.rejects(f.submit(scope), /task_budget_exhausted/);
});
test('v2 rejects injected commit fields and a tool incompatible with bound action before callback', async t => {
  const f = await fixture(t);
  f.respond(call('bad-fields', 'save_character', { ...commit, target: { kind: 'character', asset_id: 'attacker' } }),
    call('wrong-tool', 'create_chapter', commit));
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  assert.equal(f.callbacks.length, 0); assert.equal((await f.tasks.run('write', run.run_id)).error, 'forbidden_scope');
});
test('v2 permits eight candidate drafts but refuses a ninth before business dispatch', async t => {
  const f = await fixture(t);
  const run = await f.submit(scope, { budget: { max_model_calls: 8 } });
  // Batch two sequential calls in one model message to reach the candidate bound within the model budget.
  f.respond([...call('d1', 'save_character', { mode: 'draft', title: 'A', body: 'A' }), ...call('d2', 'save_character', { mode: 'draft', title: 'A', body: 'A' }),
    ...call('d3', 'save_character', { mode: 'draft', title: 'A', body: 'A' })],
    ...Array.from({ length: 6 }, (_, i) => call('more-' + i, 'save_character', { mode: 'draft', title: 'A', body: 'A' })));
  await f.tasks.execute(run.run_id, f.executor);
  assert.equal(f.callbacks.length, 8); assert.equal((await f.tasks.run('write', run.run_id)).artifacts?.length, 8);
  assert.equal((await f.tasks.run('write', run.run_id)).error, 'result_too_large');
});
test('model failure retains v2 committed results in the following task history', async t => {
  const f = await fixture(t); f.respond(call('save', 'save_character', commit), 'length');
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  assert.equal((await f.tasks.run('write', run.run_id)).error, 'incomplete_output');
  assert.equal((await f.tasks.run('write', run.run_id)).operations?.[0]?.status, 'committed');
  const next = await f.submit({ ...scope, task_id: 'next', operation_id: 'next-op', source_message_id: 'next-source' }); await f.tasks.execute(next.run_id, f.executor);
  assert.equal((await f.tasks.run('write', next.run_id)).status, 'succeeded'); assert.equal(f.opened(), 1);
  assert.ok(JSON.stringify(f.contexts.at(-1)).includes('character_created'));
});
test('v2 restart restores complete continuation history and verifies original unknown OP without replay', async t => {
  const f = await fixture(t); f.lose(); f.forge(true);
  const resolve = await f.submit(resolveScope, { budget: { max_write_operations: 0 } }); await f.tasks.execute(resolve.run_id, f.executor);
  f.respond(call('save', 'save_character', commit)); const run = await f.submit(scope, { prompt: 'Trusted execute continuation' }); await f.tasks.execute(run.run_id, f.executor);
  assert.equal((await f.tasks.run('write', run.run_id)).operations?.[0]?.status, 'unknown');
  const before = await f.tasks.piHistory('write', f.session.session_id);
  await f.tasks.close(); await f.store.close();
  const restored = await TaskStore.open(f.root); const tasks = new Tasks(restored, { send: async () => {} }, f.pi.models, f.appTools);
  try {
    await tasks.recover(); f.forge(false);
    assert.deepEqual(await tasks.piHistory('write', f.session.session_id), JSON.parse(JSON.stringify(before)));
    assert.equal((await tasks.verifyOperations('write', run.run_id)).operations?.[0]?.status, 'committed');
    assert.equal(f.callbacks.length, 1);
    const next = await tasks.submit('write', f.session.session_id, { idempotency_key: 'after-restart', provider: 'deepseek', model: f.pi.models().find(m => m.provider === 'deepseek')!.id,
      prompt: 'Continue after restart', scope: { ...scope, task_id: 'after-restart', operation_id: 'after-restart', source_message_id: 'next-source' } });
    await tasks.execute(next.run_id, piExecutor(f.pi, f.appTools));
    assert.equal((await tasks.run('write', next.run_id)).status, 'succeeded'); assert.ok(JSON.stringify(f.contexts.at(-1)).includes('Trusted execute continuation'));
  } finally { await tasks.close(); await restored.close(); }
});

test('rejected draft attempts consume tool budget but do not consume the eight-candidate allowance', async t => {
  const f = await fixture(t); f.rejectDraft();
  const candidates = Array.from({ length: 9 }, (_, i) => call('d-' + i, 'save_character', { mode: 'draft', title: 'A', body: 'A' }));
  f.respond(candidates.slice(0, 3).flat(), ...candidates.slice(3));
  const run = await f.submit(); await f.tasks.execute(run.run_id, f.executor);
  assert.equal(f.callbacks.length, 9); assert.equal((await f.tasks.run('write', run.run_id)).artifacts?.length, 8);
  assert.equal((await f.tasks.run('write', run.run_id)).status, 'succeeded');
});


test('world tool draft and exact commit retain one real Pi session through later character work and lost response', async t => {
  const f = await fixture(t, true);
  f.respond(call('world-draft', 'save_world', { mode: 'draft', title: 'World', body: 'World' }), call('world-save', 'save_world', commit));
  const run = await f.submit(worldScope); await f.tasks.execute(run.run_id, f.executor);
  const result = await f.tasks.run('write', run.run_id);
  assert.equal(result.status, 'succeeded'); assert.equal(result.artifacts?.[0]?.artifact_kind, 'world');
  assert.equal(result.operations?.[0]?.receipt && 'kind' in result.operations[0].receipt ? result.operations[0].receipt.kind : undefined, 'world_created');
  f.lose(); f.respond(call('world-update', 'save_world', commit));
  const update = await f.submit({ ...worldScope, action: 'update_world', task_id: 'update', operation_id: 'op-update', source_message_id: 'update-message' });
  await f.tasks.execute(update.run_id, f.executor);
  assert.equal((await f.tasks.run('write', update.run_id)).operations?.[0]?.status, 'committed');
  assert.equal(f.queries(), 1);
  f.respond(call('role-draft', 'save_character', { mode: 'draft', title: 'Role', body: 'Role' }));
  const role = await f.submit({ ...scope, task_id: 'role', operation_id: 'role-op', source_message_id: 'role-message' });
  await f.tasks.execute(role.run_id, f.executor);
  assert.equal((await f.tasks.run('write', role.run_id)).status, 'succeeded'); assert.equal(f.opened(), 1);
});
test('world writes obey readonly resolution, unbound preview and wrong-tool rejection', async t => {
  const f = await fixture(t, true);
  f.respond(call('world-draft', 'save_world', { mode: 'draft', title: 'World', body: 'World' }));
  const read = await f.submit(resolveScope, { budget: { max_write_operations: 0 } }); await f.tasks.execute(read.run_id, f.executor);
  assert.equal((await f.tasks.run('write', read.run_id)).error, 'forbidden_scope'); assert.equal(f.callbacks.length, 0);
  f.respond(call('world-commit', 'save_world', commit));
  const preview = await f.submit({ ...resolveScope, phase: 'execute', task_id: 'preview' }); await f.tasks.execute(preview.run_id, f.executor);
  assert.equal((await f.tasks.run('write', preview.run_id)).error, 'authorization_required');
  f.respond(call('wrong', 'save_character', commit));
  const wrong = await f.submit({ ...worldScope, task_id: 'wrong' }); await f.tasks.execute(wrong.run_id, f.executor);
  assert.equal((await f.tasks.run('write', wrong.run_id)).error, 'forbidden_scope'); assert.equal(f.callbacks.length, 0);
});
