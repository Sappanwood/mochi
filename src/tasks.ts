import { randomUUID } from 'node:crypto';
import { TaskStore } from './task-store.ts';
import { TaskError, defaultSystem, publicRun, terminal } from './task-types.ts';
import type { Dispatch, ModelInfo, Run, RunInput, StoredRun, StoredSession, Usage } from './task-types.ts';

export interface ExecutionInput { run: StoredRun; session: StoredSession; history: { role: 'user' | 'assistant'; content: string }[] }
export type Execute = (input: ExecutionInput, signal: AbortSignal, delta: (text: string) => Promise<void>) => Promise<{ text: string; usage: Usage | null }>;
const now = () => new Date().toISOString();
const object = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskError(400, 'invalid_request');
  return input as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TaskError(400, 'invalid_request');
}
function text(value: unknown, max = 65536): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max; }
export class Tasks {
  #tail: Promise<unknown> = Promise.resolve();
  #active: { id: string; controller: AbortController; done: Promise<void> } | undefined;
  #closing = false;
  readonly store: TaskStore; readonly dispatch: Dispatch; readonly models: () => ModelInfo[];
  constructor(store: TaskStore, dispatch: Dispatch, models: () => ModelInfo[]) { this.store = store; this.dispatch = dispatch; this.models = models; }
  #serial<T>(fn: () => Promise<T>) {
    const result = this.#tail.then(async () => {
      if (this.#closing) throw new TaskError(503, 'not_ready');
      await this.store.assertOwner(); return fn();
    });
    this.#tail = result.catch(() => {}); return result;
  }
  async createSession(appId: string, value: unknown) {
    const input = object(value); keys(input, ['system_prompt']);
    if (input.system_prompt !== undefined && !text(input.system_prompt)) throw new TaskError(400, 'invalid_request');
    return this.#serial(async () => {
      const session = { app_id: appId, session_id: randomUUID(), created_at: now(), system_prompt: input.system_prompt as string ?? defaultSystem };
      await this.store.saveSession(session); const { app_id: _, ...result } = session; return result;
    });
  }
  #session(appId: string, id: string) {
    const session = this.store.sessions.get(id);
    if (!session) throw new TaskError(404, 'not_found');
    if (session.app_id !== appId) throw new TaskError(403, 'forbidden'); return session;
  }
  async session(appId: string, id: string) { await this.store.assertOwner(); const { app_id: _, ...value } = this.#session(appId, id); return value; }
  #run(appId: string, id: string) {
    const run = this.store.runs.get(id);
    if (!run) throw new TaskError(404, 'not_found');
    if (run.app_id !== appId) throw new TaskError(403, 'forbidden'); return structuredClone(run);
  }
  async run(appId: string, id: string) { await this.store.assertOwner(); return publicRun(this.#run(appId, id)); }
  async byKey(appId: string, key: string) {
    await this.store.assertOwner();
    const run = [...this.store.runs.values()].find(run => run.app_id === appId && run.input.idempotency_key === key);
    if (!run) throw new TaskError(404, 'not_found'); return publicRun(run);
  }
  async history(appId: string, id: string) {
    await this.session(appId, id);
    return { messages: [...this.store.runs.values()].filter(run => run.session_id === id && run.status === 'succeeded')
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.run_id.localeCompare(b.run_id))
      .flatMap(run => [{ role: 'user' as const, content: run.input.prompt, run_id: run.run_id },
        { role: 'assistant' as const, content: run.result!.text, run_id: run.run_id }]) };
  }
  async submit(appId: string, sessionId: string, value: unknown) {
    const input = object(value); keys(input, ['idempotency_key', 'provider', 'model', 'prompt', 'max_output_tokens']);
    if (!text(input.idempotency_key, 128) || !text(input.provider, 64) || !text(input.model, 256) || !text(input.prompt)
      || (input.max_output_tokens !== undefined && (!Number.isInteger(input.max_output_tokens) || Number(input.max_output_tokens) < 1))) throw new TaskError(400, 'invalid_request');
    const model = this.models().find(model => model.provider === input.provider && model.id === input.model);
    if (!model) throw new TaskError(400, 'unsupported_model');
    const normalized: RunInput = { idempotency_key: input.idempotency_key, provider: input.provider, model: input.model,
      prompt: input.prompt, max_output_tokens: input.max_output_tokens as number ?? Math.min(4096, model.max_output_tokens) };
    if (normalized.max_output_tokens! > model.max_output_tokens) throw new TaskError(400, 'output_budget_exceeded');
    return this.#serial(async () => {
      const session = this.#session(appId, sessionId);
      const existing = [...this.store.runs.values()].find(run => run.app_id === appId && run.input.idempotency_key === normalized.idempotency_key);
      if (existing) {
        if (existing.session_id !== sessionId || JSON.stringify(existing.input) !== JSON.stringify(normalized)) throw new TaskError(409, 'idempotency_conflict');
        const copy = structuredClone(existing);
        if (copy.status === 'queued' && !copy.dispatched) await this.#dispatch(copy);
        return publicRun(copy);
      }
      if ([...this.store.runs.values()].some(run => run.session_id === sessionId && !terminal(run.status))) throw new TaskError(409, 'session_busy');
      await this.#budget(session, normalized, model);
      const time = now();
      const run: StoredRun = { app_id: appId, run_id: randomUUID(), session_id: sessionId, input: normalized,
        status: 'queued', created_at: time, updated_at: time, result: null, usage: null, error: null, dispatched: false,
        events: [{ cursor: 1, type: 'status', data: { status: 'queued' }, created_at: time }] };
      await this.store.saveRun(run); await this.#dispatch(run); return publicRun(run);
    });
  }
  async #budget(session: StoredSession, input: RunInput, model: ModelInfo) {
    const history = await this.history(session.app_id, session.session_id);
    const bytes = Buffer.byteLength(session.system_prompt + input.prompt) + history.messages.reduce((sum, m) => sum + Buffer.byteLength(m.content) + 32, 0) + 256;
    if (bytes + input.max_output_tokens! > model.context_window) throw new TaskError(400, 'context_budget_exceeded');
  }
  async #dispatch(run: StoredRun) {
    try { await this.dispatch.send(run.run_id); }
    catch { throw new TaskError(503, 'queue_unavailable'); }
    run.dispatched = true; await this.store.saveRun(run);
  }
  async events(appId: string, id: string, after: number) {
    await this.store.assertOwner(); const run = this.#run(appId, id);
    if (!Number.isSafeInteger(after) || after < 0 || after > run.events.length) throw new TaskError(400, 'invalid_cursor');
    const events = run.events.slice(after, after + 100);
    return { events, next_cursor: events.at(-1)?.cursor ?? after };
  }
  async #status(run: StoredRun, status: Run['status'], error: string | null = null) {
    run.status = status; run.updated_at = now(); run.error = error;
    run.events.push({ cursor: run.events.length + 1, type: 'status', data: { status }, created_at: run.updated_at });
    await this.store.saveRun(run);
  }
  async cancel(appId: string, id: string) {
    return this.#serial(async () => {
      const run = this.#run(appId, id);
      if (!terminal(run.status)) {
        await this.#status(run, 'cancelled');
        if (this.#active?.id === id) this.#active.controller.abort();
      }
      return publicRun(run);
    });
  }
  async reconcile(signal?: AbortSignal) {
    return this.#serial(async () => {
      for (const saved of this.store.runs.values()) {
        signal?.throwIfAborted();
        if (saved.status === 'queued' && !saved.dispatched) await this.#dispatch(structuredClone(saved));
      }
    });
  }
  async recover() {
    return this.#serial(async () => {
      for (const saved of this.store.runs.values()) {
        const run = structuredClone(saved);
        if (run.status === 'running') await this.#status(run, 'interrupted', 'process_interrupted');
        else if (run.status === 'queued') await this.#dispatch(run);
      }
    });
  }
  async execute(runId: string, execute: Execute, signal?: AbortSignal) {
    let execution: ExecutionInput | undefined;
    const controller = new AbortController();
    await this.#serial(async () => {
      if (this.#active) throw new TaskError(409, 'worker_busy');
      const stored = this.store.runs.get(runId);
      if (!stored || terminal(stored.status)) return;
      if (stored.status !== 'queued') throw new TaskError(409, 'run_not_queued');
      const run = structuredClone(stored); const session = this.#session(run.app_id, run.session_id);
      const model = this.models().find(model => model.provider === run.input.provider && model.id === run.input.model);
      if (!model) { await this.#status(run, 'failed', 'unsupported_model'); return; }
      try { await this.#budget(session, run.input, model); }
      catch { await this.#status(run, 'failed', 'context_budget_exceeded'); return; }
      execution = { run, session, history: (await this.history(run.app_id, run.session_id)).messages };
      await this.#status(run, 'running');
      this.#active = { id: runId, controller, done: Promise.resolve() };
    });
    if (!execution) return;
    const input = execution;
    const combined = AbortSignal.any([controller.signal, this.store.signal, ...(signal ? [signal] : [])]);
    const work = (async () => {
      try {
        combined.throwIfAborted();
        const result = await execute(input, combined, async delta => {
          await this.#serial(async () => {
            const run = this.#run(input.run.app_id, runId);
            if (run.status !== 'running') return;
            const size = run.events.reduce((sum, event) => sum + Buffer.byteLength(event.data.text ?? ''), 0);
            if (size + Buffer.byteLength(delta) > 1048576 || run.events.length >= 10000) throw new TaskError(413, 'output_limit');
            run.events.push({ cursor: run.events.length + 1, type: 'text_delta', data: { text: delta }, created_at: now() });
            await this.store.saveRun(run);
          });
        });
        await this.#serial(async () => {
          const run = this.#run(input.run.app_id, runId);
          if (run.status !== 'running') return;
          if (combined.aborted) { await this.#status(run, 'interrupted', 'execution_interrupted'); return; }
          if (!text(result.text, 1048576)) { await this.#status(run, 'failed', 'incomplete_output'); return; }
          run.result = { text: result.text }; run.usage = result.usage; await this.#status(run, 'succeeded');
        });
      } catch (error) {
        if (!this.store.signal.aborted) await this.#serial(async () => {
          const run = this.#run(input.run.app_id, runId);
          if (run.status !== 'running') return;
          const code = error instanceof Error && ['authentication_required', 'unsupported_model', 'context_budget_exceeded', 'incomplete_output', 'output_limit'].includes(error.message) ? error.message : 'provider_failed';
          await this.#status(run, combined.aborted ? 'interrupted' : 'failed', combined.aborted ? 'execution_interrupted' : code);
        });
      } finally { this.#active = undefined; }
    })();
    this.#active!.done = work; await work;
  }
  async close() {
    this.#active?.controller.abort(); await this.#active?.done; await this.#tail; this.#closing = true;
  }
}
