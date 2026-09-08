export interface ToolSnapshot {
  name: string; version: string; description: string; effect: 'read' | 'write'; parameters: Record<string, unknown>;
}
export interface ToolBinding {
  endpoint: string; operations_endpoint: string; audience: string;
  tools: Pick<ToolSnapshot, 'name' | 'version' | 'effect'>[];
}
export interface RunScope { task_id: string; story_id: string; source_message_id: string; operation_id: string; authorization_id?: string }
export interface RunBudget { max_model_calls: number; max_tool_calls: number; max_write_operations: number; timeout_ms: number }
export interface OperationReceipt {
  operation_id: string; status: 'committed'; story_id: string; chapter_id: string; revision: string; content_hash: string;
}
export interface CallbackRequest {
  protocol_version: 1; app_id: string; session_id: string; run_id: string; task_id: string;
  scope: Omit<RunScope, 'task_id'>; tool: Pick<ToolSnapshot, 'name' | 'version'>;
  tool_call_id: string; invocation_id: string; arguments: Record<string, unknown>;
}
export type CallbackResponse =
  | { protocol_version: 1; invocation_id: string; outcome: 'ok'; data: Record<string, unknown>; receipt?: OperationReceipt }
  | { protocol_version: 1; invocation_id: string; outcome: 'error'; error: { code: string; retryable: false } };
export type OperationResponse =
  | { protocol_version: 1; operation_id: string; status: 'committed'; receipt: OperationReceipt }
  | { protocol_version: 1; operation_id: string; status: 'rejected'; error: { code: string } }
  | { protocol_version: 1; operation_id: string; status: 'not_found' };
export interface RunOperation { operation_id: string; status: 'committed' | 'rejected' | 'unknown'; receipt?: OperationReceipt; error?: { code: string } }
export interface RunArtifact { draft_id: string; draft_revision: string; draft_hash: string; title: string }
export interface ToolInvocation {
  invocation_id: string; tool_call_id: string; name: string;
  status: 'prepared' | 'dispatched' | 'succeeded' | 'rejected' | 'unknown';
  operation_id?: string; arguments: Record<string, unknown>; response?: CallbackResponse; error?: string;
}
