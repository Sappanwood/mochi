import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { RunArtifact, RunBudget, RunOperation, RunScope, ToolInvocation, ToolSnapshot } from './tool-types.ts';
export class TaskError extends Error {
  readonly status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
export const terminal = (status: string) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status);
export interface Session { session_id: string; created_at: string; system_prompt: string; thinking_level?: 'off'; tools?: ToolSnapshot[]; tool_snapshot_hash?: string }
export interface ModelInfo { provider: string; id: string; name: string; auth: string; context_window: number; max_output_tokens: number }
export interface RunInput { idempotency_key: string; provider: string; model: string; prompt: string; max_output_tokens?: number; scope?: RunScope; budget?: RunBudget; tool_snapshot_hash?: string }
export interface Usage { input: number; output: number; cache_read: number; cache_write: number; total_tokens: number }
export interface Run {
  run_id: string; session_id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  created_at: string; updated_at: string; result: { text: string } | null; error: string | null; usage: Usage | null;
  operations?: RunOperation[]; artifacts?: RunArtifact[]; usage_complete?: boolean;
}
export interface RunEvent { cursor: number; type: 'status' | 'text_delta' | 'message' | 'tool_started' | 'tool_finished' | 'artifact_created' | 'operation_updated'; data: Record<string, unknown> & { text?: string }; created_at: string }
export type PiMessage = Extract<SessionMessageEntry['message'], { role: 'user' | 'assistant' | 'toolResult' }>;
export interface StoredMessage { run_id: string; sequence: number; message: PiMessage }
export interface StoredSession extends Session { app_id: string }
export interface StoredRun extends Run { app_id: string; input: RunInput; dispatched: boolean; events: RunEvent[]; messages?: StoredMessage[]; invocations?: ToolInvocation[] }
export interface Dispatch { send: (runId: string) => Promise<void> }
export const defaultSystem = 'You are Mochi, a conversational assistant. You have no tools or filesystem access.';
export function publicRun(run: StoredRun): Run {
  const { run_id, session_id, status, created_at, updated_at, result, error, usage } = run;
  return structuredClone({ run_id, session_id, status, created_at, updated_at, result, error, usage,
    ...(run.operations ? { operations: run.operations, artifacts: run.artifacts ?? [], usage_complete: run.usage_complete ?? false } : {}) });
}
