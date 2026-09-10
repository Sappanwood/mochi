import { TaskError } from './task-types.ts';
import type { ScopeV2, ToolSnapshot, OperationBinding, ReceiptV2, RunScope } from './tool-types.ts';
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export const text = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max;
export const hash = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export function target(v: unknown): boolean {
  return object(v) && (v.kind === 'character' ? keys(v, ['kind', 'asset_id']) && text(v.asset_id)
    : v.kind === 'story' && keys(v, ['kind', 'story_id']) && text(v.story_id));
}
export const actionKinds = { create_character: 'character_created', update_character: 'character_updated', initialize_story: 'story_initialized',
  save_first_chapter: 'first_chapter_saved', create_chapter: 'chapter_created' } as const;
export function scopeV2(v: unknown): ScopeV2 {
  function invalid(): never { throw new TaskError(400, 'invalid_request'); }
  if (!object(v) || !keys(v, ['protocol_version', 'conversation_id', 'task_id', 'source_message_id', 'operation_id', 'phase', 'refs_digest', 'binding_digest', 'authorization_id', 'target', 'action'])
    || v.protocol_version !== 2 || !['resolve', 'execute'].includes(String(v.phase)) || !hash(v.refs_digest)
    || ['conversation_id', 'task_id', 'source_message_id', 'operation_id'].some(k => !text(v[k]))) invalid();
  const fields = ['binding_digest', 'authorization_id', 'target', 'action'];
  if (fields.some(k => k in v)) {
    if (v.phase !== 'execute' || !hash(v.binding_digest) || !text(v.authorization_id) || !target(v.target)
      || !Object.hasOwn(actionKinds, String(v.action))) invalid();
    const expected = ['create_character', 'update_character'].includes(String(v.action)) ? 'character' : 'story';
    if ((v.target as Record<string, unknown>).kind !== expected) invalid();
  }
  return structuredClone(v) as unknown as ScopeV2;
}
const descriptors = [
  ['library_vocabulary', '1', 'read'], ['search_library', '1', 'read'], ['read_library', '1', 'read'],
  ['search_assets', '2', 'read'], ['read_asset', '2', 'read'], ['discover_artifacts', '2', 'read'], ['read_artifact', '2', 'read'],
  ['save_character', '2', 'write'], ['initialize_story', '2', 'write'], ['create_chapter', '2', 'write'],
];
export const isV2Tool = (tool: Pick<ToolSnapshot, 'name' | 'version'>) => descriptors.some(([name, version]) => tool.name === name && tool.version === version);
export function validateProtocol(tools: ToolSnapshot[] | undefined, protocol: unknown) {
  if (protocol === undefined) {
    if (tools?.some(t => t.version === '2')) throw new TaskError(400, 'invalid_request');
    return;
  }
  if (protocol !== 2 || tools?.length !== descriptors.length
    || tools.some((t, i) => JSON.stringify([t.name, t.version, t.effect]) !== JSON.stringify(descriptors[i]))) throw new TaskError(400, 'invalid_request');
}
export function operationBinding(tool: OperationBinding['tool'], scope: RunScope, args: Record<string, unknown>): OperationBinding {
  return { tool, arguments: args, ...(scope.protocol_version === 2 ? { scope } : { story_id: scope.story_id }) };
}
export function receiptV2(v: unknown, operationId: string, binding: OperationBinding | undefined): v is ReceiptV2 {
  const s = binding?.scope;
  if (!s || !s.target || !s.action || !binding || !object(v)
    || !keys(v, ['protocol_version', 'operation_id', 'status', 'conversation_id', 'task_id', 'kind', 'target', 'draft_id', 'draft_revision', 'draft_hash', 'content_hash', 'revision', 'assets', 'chapter'])
    || v.protocol_version !== 2 || v.operation_id !== operationId || operationId !== s.operation_id || v.status !== 'committed'
    || v.conversation_id !== s.conversation_id || v.task_id !== s.task_id || v.kind !== actionKinds[s.action]
    || !target(v.target) || !sameTarget(v.target, s.target) || !text(v.revision) || !hash(v.content_hash)
    || !text(v.draft_id) || v.draft_revision !== '1' || !hash(v.draft_hash)
    || ['draft_id', 'draft_revision', 'draft_hash'].some(k => v[k] !== binding.arguments[k])) return false;
  const tool = s.target.kind === 'character' ? 'save_character' : s.action === 'create_chapter' ? 'create_chapter' : 'initialize_story';
  if (binding.tool.name !== tool || binding.tool.version !== '2' || binding.arguments.mode !== 'commit') return false;
  if (s.target.kind === 'character') return !('assets' in v) && !('chapter' in v);
  const chapter = (c: unknown) => object(c) && keys(c, ['chapter_id', 'revision', 'content_hash']) && text(c.chapter_id) && text(c.revision) && hash(c.content_hash);
  if (s.action === 'create_chapter') return !('assets' in v) && chapter(v.chapter)
    && v.content_hash === (v.chapter as Record<string, unknown>).content_hash && v.revision === (v.chapter as Record<string, unknown>).revision;
  if (v.content_hash !== v.draft_hash || !Array.isArray(v.assets) || v.assets.length > 8) return false;
  const ids = new Set<string>(); const kinds = new Set<string>();
  for (const a of v.assets) {
    if (!object(a) || !keys(a, ['asset_id', 'kind', 'revision', 'content_hash']) || !text(a.asset_id) || !text(a.revision) || !hash(a.content_hash)
      || !['setting', 'outline', 'snapshot'].includes(String(a.kind)) || ids.has(a.asset_id) || (a.kind !== 'snapshot' && kinds.has(String(a.kind)))) return false;
    ids.add(a.asset_id); kinds.add(String(a.kind));
  }
  return s.action === 'initialize_story' ? !('chapter' in v) : chapter(v.chapter);
}
function sameTarget(a: unknown, b: ScopeV2['target']) {
  return object(a) && b && a.kind === b.kind && (b.kind === 'character' ? a.asset_id === b.asset_id : a.story_id === b.story_id);
}
export function artifactV2(data: Record<string, unknown>, tool: string): boolean {
  const kind = tool === 'save_character' ? 'character' : tool === 'initialize_story' ? 'story_initialization' : 'chapter';
  if (!keys(data, ['draft_id', 'draft_revision', 'draft_hash', 'group_id', 'ordinal', 'title', 'artifact_kind', 'parent_ref', 'members'])
    || !text(data.draft_id) || data.draft_revision !== '1' || !hash(data.draft_hash) || !text(data.group_id) || !text(data.title, 512)
    || !Number.isSafeInteger(data.ordinal) || Number(data.ordinal) < 1 || data.artifact_kind !== kind) return false;
  if ('parent_ref' in data && !candidateRef(data.parent_ref)) return false;
  if ('members' in data && (kind !== 'story_initialization' || !Array.isArray(data.members) || data.members.length > 8
    || data.members.some(m => !object(m) || !text(m.member_id) || !text(m.title, 512) || !['setting', 'outline', 'snapshot'].includes(String(m.kind))))) return false;
  return true;
}
function candidateRef(v: unknown): boolean {
  return object(v) && keys(v, ['type', 'group_id', 'draft_id', 'draft_revision', 'draft_hash', 'member_id'])
    && v.type === 'candidate' && text(v.group_id) && text(v.draft_id) && v.draft_revision === '1' && hash(v.draft_hash)
    && (!('member_id' in v) || text(v.member_id));
}
