import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-store.ts';
import { Tasks } from '../src/tasks.ts';

const models = [{ provider: 'deepseek', id: 'test', name: 'Test', auth: 'api_key', context_window: 10000, max_output_tokens: 1000 }];
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mochi-tasks-'));
  const store = await TaskStore.open(root);
  const sent: string[] = [];
  const tasks = new Tasks(store, { send: async id => { sent.push(id); } }, () => models);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, tasks, sent };
}
test('durable submission deduplicates and rejects changed input and app escape', async t => {
  const { tasks, sent } = await setup(t);
  const session = await tasks.createSession('app-a', { system_prompt: 'stable' });
  const input = { idempotency_key: 'request-1', provider: 'deepseek', model: 'test', prompt: 'hello' };
  const a = await tasks.submit('app-a', session.session_id, input);
  const b = await tasks.submit('app-a', session.session_id, input);
  assert.equal(a.run_id, b.run_id); assert.equal(sent.length, 1);
  await assert.rejects(tasks.submit('app-a', session.session_id, { ...input, prompt: 'different' }), /idempotency_conflict/);
  await assert.rejects(tasks.session('app-b', session.session_id), /forbidden/);
  assert.equal((await tasks.byKey('app-a', 'request-1')).run_id, a.run_id);
  await assert.rejects(tasks.byKey('app-b', 'request-1'), /not_found/);
});
test('queue failure leaves queryable task and same key repairs dispatch without new run', async t => {
  const { store } = await setup(t); let fails = true;
  const tasks = new Tasks(store, { send: async () => { if (fails) throw new Error('queue down'); } }, () => models);
  const session = await tasks.createSession('app-a', {});
  const input = { idempotency_key: 'retry', provider: 'deepseek', model: 'test', prompt: 'hello' };
  await assert.rejects(tasks.submit('app-a', session.session_id, input), /queue_unavailable/);
  const saved = await tasks.byKey('app-a', 'retry'); fails = false;
  assert.equal((await tasks.submit('app-a', session.session_id, input)).run_id, saved.run_id);
});

test('terminal result, durable event cursor and history survive restart without duplicate execution', async t => {
  const { store, tasks } = await setup(t);
  const session = await tasks.createSession('app-a', { system_prompt: 'stable' });
  const run = await tasks.submit('app-a', session.session_id, { idempotency_key: 'one', provider: 'deepseek', model: 'test', prompt: 'first' });
  let calls = 0;
  const execute = async (_input: unknown, _signal: AbortSignal, delta: (text: string) => Promise<void>) => {
    calls++; await delta('answer'); return { text: 'answer', usage: null };
  };
  await tasks.execute(run.run_id, execute); await tasks.execute(run.run_id, execute);
  assert.equal(calls, 1); assert.deepEqual((await tasks.run('app-a', run.run_id)).result, { text: 'answer' });
  const events = await tasks.events('app-a', run.run_id, 1);
  assert.deepEqual(events.events.map(e => e.type), ['status', 'text_delta', 'status']); assert.equal(events.next_cursor, 4);
  await assert.rejects(tasks.events('app-a', run.run_id, 99), /invalid_cursor/);
  await store.close();
  const restored = await TaskStore.open(store.root); t.after(() => restored.close());
  const next = new Tasks(restored, { send: async () => { throw new Error('must not requeue terminal'); } }, () => models);
  await next.recover(); await next.execute(run.run_id, execute);
  assert.equal(calls, 1); assert.equal((await next.history('app-a', session.session_id)).messages.length, 2);
  assert.equal((await next.session('app-a', session.session_id)).system_prompt, 'stable'); await restored.close();
});

test('uncertain running task becomes interrupted on restart and queued tasks are re-dispatched', async t => {
  const { tasks, store } = await setup(t);
  const session = await tasks.createSession('app-a', {});
  const run = await tasks.submit('app-a', session.session_id, { idempotency_key: 'one', provider: 'deepseek', model: 'test', prompt: 'first' });
  const saved = structuredClone(store.runs.get(run.run_id)!); saved.status = 'running'; await store.saveRun(saved);
  const other = await tasks.createSession('app-b', {});
  const queued = await tasks.submit('app-b', other.session_id, { idempotency_key: 'two', provider: 'deepseek', model: 'test', prompt: 'second' });
  await store.close(); const restored = await TaskStore.open(store.root); t.after(() => restored.close());
  const sent: string[] = []; const next = new Tasks(restored, { send: async id => { sent.push(id); } }, () => models);
  await next.recover();
  assert.equal((await next.run('app-a', run.run_id)).status, 'interrupted'); assert.deepEqual(sent, [queued.run_id]); await restored.close();
});

test('cancellation preserves terminal state even when provider ignores abort, no partial adoption', async t => {
  const { tasks } = await setup(t);
  const session = await tasks.createSession('app-a', {});
  const run = await tasks.submit('app-a', session.session_id, { idempotency_key: 'one', provider: 'deepseek', model: 'test', prompt: 'first' });
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; }); const wait = new Promise<void>(r => { release = r; });
  const execution = tasks.execute(run.run_id, async (_input, signal, delta) => {
    await delta('partial'); entered(); await wait; assert.equal(signal.aborted, true); return { text: 'late', usage: null };
  });
  await started;
  assert.equal((await tasks.cancel('app-a', run.run_id)).status, 'cancelled'); release(); await execution;
  assert.equal((await tasks.run('app-a', run.run_id)).result, null);
  assert.deepEqual((await tasks.history('app-a', session.session_id)).messages, []);
});

test('one global execution, session busy, failures sanitized, context and output budgets reject', async t => {
  const { tasks } = await setup(t);
  const session = await tasks.createSession('app-a', {});
  const input = { idempotency_key: 'one', provider: 'deepseek', model: 'test', prompt: 'first' };
  const run = await tasks.submit('app-a', session.session_id, input);
  await assert.rejects(tasks.submit('app-a', session.session_id, { ...input, idempotency_key: 'two' }), /session_busy/);
  let done!: () => void; let entered!: () => void;
  const wait = new Promise<void>(r => { done = r; }); const started = new Promise<void>(r => { entered = r; });
  const execution = tasks.execute(run.run_id, async () => { entered(); await wait; throw new Error('private-provider-token'); });
  await started; await assert.rejects(tasks.execute(run.run_id, async () => ({ text: 'wrong', usage: null })), /worker_busy/);
  done(); await execution; const failed = await tasks.run('app-a', run.run_id);
  assert.equal(failed.error, 'provider_failed'); assert.ok(!JSON.stringify(failed).includes('private'));
  await assert.rejects(tasks.submit('app-a', session.session_id, { ...input, idempotency_key: 'two', prompt: 'x'.repeat(10000) }), /context_budget_exceeded/);
  await assert.rejects(tasks.submit('app-a', session.session_id, { ...input, max_output_tokens: 1001 }), /output_budget_exceeded/);
  await assert.rejects(tasks.submit('app-a', session.session_id, { ...input, app_id: 'forged' }), /invalid_request/);
});

test('runtime outbox repairs failed send in same process without touching running or terminal tasks', async t => {
  const { store } = await setup(t); let unavailable = true; const sent: string[] = [];
  const tasks = new Tasks(store, { send: async id => { if (unavailable) throw new Error('temporary'); sent.push(id); } }, () => models);
  const session = await tasks.createSession('app-a', {});
  const input = { idempotency_key: 'outbox', provider: 'deepseek', model: 'test', prompt: 'hello' };
  await assert.rejects(tasks.submit('app-a', session.session_id, input), /queue_unavailable/);
  const run = await tasks.byKey('app-a', 'outbox'); unavailable = false;
  await tasks.reconcile(); assert.deepEqual(sent, [run.run_id]);
  let release!: () => void; let started!: () => void;
  const wait = new Promise<void>(r => { release = r; }); const entered = new Promise<void>(r => { started = r; });
  const execution = tasks.execute(run.run_id, async () => { started(); await wait; return { text: 'done', usage: null }; });
  await entered; await tasks.reconcile(); assert.equal((await tasks.run('app-a', run.run_id)).status, 'running');
  release(); await execution; await tasks.reconcile(); assert.deepEqual(sent, [run.run_id]);
  await tasks.close(); await assert.rejects(tasks.reconcile(), /not_ready/);
});
