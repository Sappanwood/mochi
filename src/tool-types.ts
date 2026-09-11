export interface ToolSnapshot {
  name: string; version: string; description: string; effect: 'read' | 'write'; parameters: Record<string, unknown>;
}
export interface ToolBinding {
  endpoint: string; operations_endpoint: string; audience: string;
  tools: Pick<ToolSnapshot, 'name' | 'version' | 'effect'>[];
}
export interface ScopeV1 { protocol_version?: never; task_id: string; story_id: string; source_message_id: string; operation_id: string; authorization_id?: string }
export interface RunBudget { max_model_calls: number; max_tool_calls: number; max_write_operations: number; timeout_ms: number }
export interface ChapterReceipt {
  operation_id: string; status: 'committed'; story_id: string; chapter_id: string; revision: string; content_hash: string;
}
interface InitializationReceiptBase {
  operation_id: string; status: 'committed'; story_id: string; revision: string; content_hash: string;
  draft_id: string; draft_revision: string; draft_hash: string;
  assets: { asset_id: string; kind: 'setting' | 'outline' | 'snapshot'; revision: string; content_hash: string }[];
}
export type InitializationReceipt = InitializationReceiptBase & (
  | { kind: 'story_initialized'; chapter?: never }
  | { kind: 'first_chapter_saved'; chapter: { chapter_id: string; revision: string; content_hash: string } }
);
export type TargetV2 = { kind: 'character' | 'world'; asset_id: string } | { kind: 'story'; story_id: string };
export type ActionV2 = 'create_world' | 'update_world' | 'create_character' | 'update_character' | 'initialize_story' | 'save_first_chapter' | 'create_chapter';
export interface ScopeV2 {
  protocol_version: 2; story_id?: never; conversation_id: string; task_id: string; source_message_id: string; operation_id: string;
  phase: 'resolve' | 'execute'; refs_digest: string;
  target?: TargetV2; authorization_id?: string; binding_digest?: string; action?: ActionV2;
}
export type RunScope = ScopeV1 | ScopeV2;
export interface ReceiptV2 {
  protocol_version: 2; operation_id: string; status: 'committed'; conversation_id: string; task_id: string;
  kind: 'world_created' | 'world_updated' | 'character_created' | 'character_updated' | 'story_initialized' | 'first_chapter_saved' | 'chapter_created';
  target: TargetV2; draft_id: string; draft_revision: string; draft_hash: string; content_hash: string; revision: string;
  assets?: InitializationReceipt['assets']; chapter?: { chapter_id: string; revision: string; content_hash: string };
}
export type OperationReceipt = ChapterReceipt | InitializationReceipt | ReceiptV2;
export interface OperationBinding {
  tool: Pick<ToolSnapshot, 'name' | 'version'>; story_id?: string; scope?: ScopeV2; arguments: Record<string, unknown>;
}
export interface CallbackRequest {
  protocol_version: 1 | 2; app_id: string; session_id: string; run_id: string; task_id: string;
  scope: Omit<ScopeV1, 'task_id'> | Omit<ScopeV2, 'task_id'>; tool: Pick<ToolSnapshot, 'name' | 'version'>;
  tool_call_id: string; invocation_id: string; arguments: Record<string, unknown>;
}
export type CallbackResponse =
  | { protocol_version: 1 | 2; invocation_id: string; outcome: 'ok'; data: Record<string, unknown>; receipt?: OperationReceipt }
  | { protocol_version: 1 | 2; invocation_id: string; outcome: 'error'; error: { code: string; retryable: false } };
export type OperationResponse =
  | { protocol_version: 1; operation_id: string; status: 'committed'; receipt: OperationReceipt }
  | { protocol_version: 1; operation_id: string; status: 'rejected'; error: { code: string } }
  | { protocol_version: 1; operation_id: string; status: 'not_found' }
  | { protocol_version: 2; operation_id: string; status: 'committed'; receipt: ReceiptV2 }
  | { protocol_version: 2; operation_id: string; status: 'unknown' | 'revoked' | 'conflict' };
export interface RunOperation { operation_id: string; status: 'committed' | 'rejected' | 'unknown' | 'revoked' | 'conflict'; receipt?: OperationReceipt; error?: { code: string } }
export type RunArtifact = { draft_id: string; draft_revision: string; draft_hash: string; title: string } & (
  | { artifact_kind?: never; includes_chapter?: never }
  | { artifact_kind: 'story_initialization'; includes_chapter: boolean }
  | { artifact_kind: 'world' | 'character' | 'story_initialization' | 'chapter'; group_id: string; ordinal: number; parent_ref?: Record<string, unknown>; members?: Record<string, unknown>[] }
);
export interface ToolInvocation {
  invocation_id: string; tool_call_id: string; name: string;
  status: 'prepared' | 'dispatched' | 'succeeded' | 'rejected' | 'unknown';
  operation_id?: string; arguments: Record<string, unknown>; response?: CallbackResponse; error?: string;
}
