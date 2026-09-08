import { randomUUID } from 'node:crypto';
import { TaskStore } from './task-store.ts';
import { TaskError, defaultSystem, publicRun, terminal } from './task-types.ts';
import type { Dispatch, ModelInfo, PiMessage, Run, RunInput, StoredRun, StoredSession, Usage } from './task-types.ts';
import { AppTools, formalCommit } from './app-tools.ts';
import type { RunArtifact, RunBudget, RunOperation, RunScope, ToolInvocation } from './tool-types.ts';

export interface ExecutionInput { run: StoredRun; session: StoredSession; history: { role: 'user' | 'assistant'; content: string }[]; piHistory?: PiMessage[] }
export type ExecutionRecord = { kind: 'message'; message: PiMessage } | { kind: 'invocation'; invocation: ToolInvocation }
  | { kind: 'operation'; operation: RunOperation } | { kind: 'artifact'; artifact: RunArtifact }
  | { kind: 'usage'; usage: Usage | null; complete: boolean };
export type RecordExecution = (record: ExecutionRecord) => Promise<void>;
export type Execute = (input: ExecutionInput, signal: AbortSignal, delta: (text: string) => Promise<void>, record?: RecordExecution) => Promise<{ text: string; usage: Usage | null; usage_complete?: boolean }>;
export const defaultRunBudget: RunBudget = { max_model_calls: 8, max_tool_calls: 20, max_write_operations: 1, timeout_ms: 300000 };
function toolScope(value: unknown): RunScope {
  const scope = object(value); keys(scope, ['task_id', 'story_id', 'source_message_id', 'operation_id', 'authorization_id']);
  if (['task_id', 'story_id', 'source_message_id', 'operation_id'].some(key => !text(scope[key], 128))
    || (scope.authorization_id !== undefined && !text(scope.authorization_id, 128))) throw new TaskError(400, 'invalid_request');
  return { task_id: scope.task_id as string, story_id: scope.story_id as string, source_message_id: scope.source_message_id as string,
    operation_id: scope.operation_id as string, ...(scope.authorization_id === undefined ? {} : { authorization_id: scope.authorization_id as string }) };
}
function toolBudget(value: unknown): RunBudget {
  const budget = value === undefined ? {} : object(value); keys(budget, Object.keys(defaultRunBudget));
  const result = { ...defaultRunBudget, ...budget } as RunBudget;
  for (const key of Object.keys(defaultRunBudget) as (keyof RunBudget)[]) {
    const min = key === 'timeout_ms' ? 1000 : key === 'max_write_operations' ? 0 : 1;
    if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > defaultRunBudget[key]) throw new TaskError(400, 'invalid_request');
  }
  return result;
}
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
  readonly store: TaskStore; readonly dispatch: Dispatch; readonly models: () => ModelInfo[]; readonly appTools: AppTools;
  constructor(store: TaskStore, dispatch: Dispatch, models: () => ModelInfo[], appTools = new AppTools({})) { this.store = store; this.dispatch = dispatch; this.models = models; this.appTools = appTools; }
  #serial<T>(fn: () => Promise<T>) {
    const result = this.#tail.then(async () => {
      if (this.#closing) throw new TaskError(503, 'not_ready');
      await this.store.assertOwner(); return fn();
    });
    this.#tail = result.catch(() => {}); return result;
  }
  async createSession(appId: string, value: unknown) {
    const input = object(value); keys(input, ['system_prompt', 'tools', 'thinking_level']);
    const snapshot = this.appTools.validate(appId, input.tools);
    if (snapshot && !text(input.system_prompt)) throw new TaskError(400, 'invalid_request');
    if (input.system_prompt !== undefined && !text(input.system_prompt)) throw new TaskError(400, 'invalid_request');
    if (input.thinking_level !== undefined && input.thinking_level !== 'off') throw new TaskError(400, 'invalid_request');
    return this.#serial(async () => {
      const session: StoredSession = { app_id: appId, session_id: randomUUID(), created_at: now(), system_prompt: input.system_prompt as string ?? defaultSystem,
        ...(input.thinking_level === 'off' ? { thinking_level: 'off' } : {}), ...snapshot };
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
    const input = object(value); keys(input, ['idempotency_key', 'provider', 'model', 'prompt', 'max_output_tokens', 'scope', 'budget']);
    if (!text(input.idempotency_key, 128) || !text(input.provider, 64) || !text(input.model, 256) || !text(input.prompt)
      || (input.max_output_tokens !== undefined && (!Number.isInteger(input.max_output_tokens) || Number(input.max_output_tokens) < 1))) throw new TaskError(400, 'invalid_request');
    const model = this.models().find(model => model.provider === input.provider && model.id === input.model);
    if (!model) throw new TaskError(400, 'unsupported_model');
    const normalized: RunInput = { idempotency_key: input.idempotency_key, provider: input.provider, model: input.model,
      prompt: input.prompt, max_output_tokens: input.max_output_tokens as number ?? Math.min(4096, model.max_output_tokens) };
    if (normalized.max_output_tokens! > model.max_output_tokens) throw new TaskError(400, 'output_budget_exceeded');
    return this.#serial(async () => {
      const session = this.#session(appId, sessionId);
      if (session.tools?.length) {
        this.appTools.assertSupported(appId, session.tools);
        normalized.scope = toolScope(input.scope); normalized.budget = toolBudget(input.budget); normalized.tool_snapshot_hash = session.tool_snapshot_hash;
      } else if (input.scope !== undefined || input.budget !== undefined) throw new TaskError(400, 'invalid_request');
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
        events: [{ cursor: 1, type: 'status', data: { status: 'queued' }, created_at: time }],
        ...(session.tools?.length ? { operations: [], artifacts: [], usage_complete: true, messages: [], invocations: [] } : {}) };
      await this.store.saveRun(run); await this.#dispatch(run); return publicRun(run);
    });
  }
  async #budget(session: StoredSession, input: RunInput, model: ModelInfo) {
    const history = await this.history(session.app_id, session.session_id);
    const messageBytes = session.tools?.length ? Buffer.byteLength(JSON.stringify(this.#piHistory(session.session_id))) + Buffer.byteLength(JSON.stringify(session.tools))
      : history.messages.reduce((sum, m) => sum + Buffer.byteLength(m.content) + 32, 0);
    const bytes = Buffer.byteLength(session.system_prompt + input.prompt) + messageBytes + 256;
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
        if (run.status === 'running') {
          for (const invocation of run.invocations ?? []) if (invocation.status === 'dispatched') {
            invocation.status = 'unknown';
            if (invocation.operation_id && !(run.operations ?? []).some(op => op.operation_id === invocation.operation_id))
              (run.operations ??= []).push({ operation_id: invocation.operation_id, status: 'unknown' });
          }
          await this.#status(run, 'interrupted', 'process_interrupted');
        }
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
      try { if (session.tools?.length) this.appTools.assertSupported(run.app_id, session.tools); await this.#budget(session, run.input, model); }
      catch (error) { await this.#status(run, 'failed', error instanceof Error && error.message === 'tool_version_unavailable' ? error.message : 'context_budget_exceeded'); return; }
      execution = { run, session, history: (await this.history(run.app_id, run.session_id)).messages,
        ...(session.tools?.length ? { piHistory: this.#piHistory(session.session_id) } : {}) };
      await this.#status(run, 'running');
      this.#active = { id: runId, controller, done: Promise.resolve() };
    });
    if (!execution) return;
    const input = execution;
    const deadline = input.run.input.budget ? AbortSignal.timeout(input.run.input.budget.timeout_ms) : undefined;
    const combined = AbortSignal.any([controller.signal, this.store.signal, ...(signal ? [signal] : []), ...(deadline ? [deadline] : [])]);
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
        }, record => this.#record(input.run.app_id, runId, record));
        await this.#serial(async () => {
          const run = this.#run(input.run.app_id, runId);
          if (run.status !== 'running') return;
          if (combined.aborted) { await this.#status(run, 'interrupted', 'execution_interrupted'); return; }
          if (!text(result.text, 1048576)) { await this.#status(run, 'failed', 'incomplete_output'); return; }
          if (run.operations?.some(op => op.status === 'unknown')) { await this.#status(run, 'failed', 'tool_result_unknown'); return; }
          run.result = { text: result.text }; run.usage = result.usage;
          if (run.operations) run.usage_complete = result.usage_complete ?? run.usage_complete;
          await this.#status(run, 'succeeded');
        });
      } catch (error) {
        if (!this.store.signal.aborted) await this.#serial(async () => {
          const run = this.#run(input.run.app_id, runId);
          if (run.status !== 'running') return;
          const code = error instanceof Error && ['authentication_required', 'unsupported_model', 'context_budget_exceeded', 'incomplete_output', 'output_limit', 'model_call_limit', 'tool_call_limit', 'write_operation_limit', 'run_timeout', 'tool_transport_failed', 'tool_result_unknown', 'tool_version_unavailable'].includes(error.message) ? error.message : 'provider_failed';
          await this.#status(run, deadline?.aborted ? 'failed' : combined.aborted ? 'interrupted' : 'failed', deadline?.aborted ? 'run_timeout' : combined.aborted ? 'execution_interrupted' : code);
        });
      } finally { this.#active = undefined; }
    })();
    this.#active!.done = work; await work;
  }

  #orderedRuns(sessionId: string) {
    return [...this.store.runs.values()].filter(run => run.session_id === sessionId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.run_id.localeCompare(b.run_id));
  }
  #piHistory(sessionId: string): PiMessage[] {
    return this.#orderedRuns(sessionId).filter(run => run.status === 'succeeded').flatMap(run => (run.messages ?? []).map(record => record.message));
  }
  async piHistory(appId: string, sessionId: string) {
    await this.session(appId, sessionId);
    return { format: 'pi-v1', messages: this.#orderedRuns(sessionId).flatMap(run => run.messages ?? []) };
  }
  async #record(appId: string, runId: string, record: ExecutionRecord) {
    await this.#serial(async () => {
      const run = this.#run(appId, runId);
      if (!run.operations) throw new Error('unexpected_tools');
      const event = (type: StoredRun['events'][number]['type'], data: Record<string, unknown>) => {
        if (run.events.length >= 10000) throw new TaskError(413, 'output_limit');
        run.events.push({ cursor: run.events.length + 1, type, data: structuredClone(data), created_at: now() });
      };
      if (record.kind === 'message') {
        const sequence = Math.max(0, ...this.#orderedRuns(run.session_id).flatMap(run => (run.messages ?? []).map(m => m.sequence))) + 1;
        (run.messages ??= []).push({ run_id: runId, sequence, message: structuredClone(record.message) });
        event('message', { sequence, message: record.message });
      } else if (record.kind === 'invocation') {
        const invocation = record.invocation;
        const records = run.invocations ??= []; const index = records.findIndex(item => item.invocation_id === invocation.invocation_id);
        if (index >= 0) records[index] = structuredClone(invocation); else records.push(structuredClone(invocation));
        if (invocation.status === 'dispatched') event('tool_started', { invocation_id: invocation.invocation_id, tool_call_id: invocation.tool_call_id, name: invocation.name });
        else if (!['prepared'].includes(invocation.status)) event('tool_finished', { invocation_id: invocation.invocation_id, tool_call_id: invocation.tool_call_id, name: invocation.name, status: invocation.status, ...(invocation.error ? { error: invocation.error } : {}) });
      } else if (record.kind === 'operation') {
        const operation = record.operation; const index = run.operations.findIndex(op => op.operation_id === operation.operation_id);
        if (index >= 0 && run.operations[index]?.status === 'committed' && operation.status !== 'committed') return;
        if (index >= 0) run.operations[index] = structuredClone(operation); else run.operations.push(structuredClone(operation));
        event('operation_updated', { ...operation });
      } else if (record.kind === 'artifact') {
        if (!(run.artifacts ??= []).some(item => item.draft_id === record.artifact.draft_id)) run.artifacts.push(structuredClone(record.artifact));
        event('artifact_created', { ...record.artifact });
      } else { run.usage = record.usage; run.usage_complete = record.complete; }
      await this.store.saveRun(run);
    });
  }
  async verifyOperations(appId: string, runId: string) {
    const current = await this.run(appId, runId);
    if (!current.operations || !terminal(current.status)) throw new TaskError(409, 'run_not_terminal');
    for (const operation of current.operations.filter(op => op.status === 'unknown')) {
      const stored = this.#run(appId, runId);
      const invocation = stored.invocations?.find(item => item.operation_id === operation.operation_id && item.status !== 'prepared');
      const tool = this.store.sessions.get(stored.session_id)?.tools?.find(item => item.name === invocation?.name);
      if (!invocation || !tool || tool.effect !== 'write' || !formalCommit(tool, invocation.arguments) || !stored.input.scope) throw new Error('tool_transport_failed');
      const result = await this.appTools.operation(appId, operation.operation_id, AbortSignal.timeout(15000),
        { tool, story_id: stored.input.scope.story_id, arguments: invocation.arguments });
      if (result.status === 'committed') {
        if (result.receipt.story_id !== this.#run(appId, runId).input.scope?.story_id) throw new Error('tool_transport_failed');
        await this.#record(appId, runId, { kind: 'operation', operation: { operation_id: result.operation_id, status: 'committed', receipt: result.receipt } });
      }
      else if (result.status === 'rejected') await this.#record(appId, runId, { kind: 'operation', operation: { operation_id: result.operation_id, status: 'rejected', error: result.error } });
    }
    return this.run(appId, runId);
  }
  async close() {
    this.#active?.controller.abort(); await this.#active?.done; await this.#tail; this.#closing = true;
  }
}
