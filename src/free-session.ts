import { TaskError } from './task-types.ts';
import type { ScopeV2, ToolSnapshot, OperationBinding, ReceiptV2, RunScope } from './tool-types.ts';
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export const text = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max;
export const hash = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export function target(v: unknown): boolean {
  return object(v) && (['character', 'world'].includes(String(v.kind)) ? keys(v, ['kind', 'asset_id']) && text(v.asset_id)
    : v.kind === 'story' && keys(v, ['kind', 'story_id']) && text(v.story_id));
}
export const actionKinds = { revise_story_materials: 'story_materials_saved', create_world: 'world_created', update_world: 'world_updated', create_character: 'character_created', update_character: 'character_updated', initialize_story: 'story_initialized',
  save_first_chapter: 'first_chapter_saved', create_chapter: 'chapter_created' } as const;
export function scopeV2(v: unknown): ScopeV2 {
  function invalid(): never { throw new TaskError(400, 'invalid_request'); }
  if (!object(v) || !keys(v, ['protocol_version', 'conversation_id', 'task_id', 'source_message_id', 'operation_id', 'phase', 'refs_digest', 'binding_digest', 'authorization_id', 'target', 'action', 'material_members'])
    || v.protocol_version !== 2 || !['resolve', 'execute'].includes(String(v.phase)) || !hash(v.refs_digest)
    || ['conversation_id', 'task_id', 'source_message_id', 'operation_id'].some(k => !text(v[k]))) invalid();
  const fields = ['binding_digest', 'authorization_id', 'target', 'action'];
  if (fields.some(k => k in v)) {
    if (v.phase !== 'execute' || !hash(v.binding_digest) || !text(v.authorization_id) || !target(v.target)
      || !Object.hasOwn(actionKinds, String(v.action))) invalid();
    const expected = ['create_world', 'update_world'].includes(String(v.action)) ? 'world' : ['create_character', 'update_character'].includes(String(v.action)) ? 'character' : 'story';
    if ((v.target as Record<string, unknown>).kind !== expected) invalid();
  }
  if (v.action === 'revise_story_materials' ? !validMaterials(v.material_members) : 'material_members' in v) invalid();
  return structuredClone(v) as unknown as ScopeV2;
}
function validMaterials(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return false;
  const ids = new Set<string>(), memberKeys = new Set<string>(), singletons = new Set<string>();
  return value.every(m => {
    if (!object(m) || !keys(m, ['key', 'kind', 'mode', 'asset_id', 'base_revision', 'base_version'])
      || !text(m.key) || !text(m.asset_id) || !['snapshot', 'setting', 'outline'].includes(String(m.kind))
      || ids.has(m.asset_id) || memberKeys.has(m.key) || (m.kind !== 'snapshot' && singletons.has(String(m.kind)))
      || (m.mode === 'create' ? m.kind !== 'snapshot' || m.base_revision !== null || m.base_version !== 0
        : m.mode !== 'update' || !text(m.base_revision) || !Number.isSafeInteger(m.base_version) || Number(m.base_version) < 1)) return false;
    ids.add(m.asset_id); memberKeys.add(m.key); singletons.add(String(m.kind)); return true;
  });
}
const descriptors = [
  ['library_vocabulary', '1', 'read'], ['search_library', '1', 'read'], ['read_library', '1', 'read'],
  ['search_assets', '2', 'read'], ['read_asset', '2', 'read'], ['discover_artifacts', '2', 'read'], ['read_artifact', '2', 'read'],
  ['save_character', '2', 'write'], ['initialize_story', '2', 'write'], ['create_chapter', '2', 'write'],
];
const worldDescriptors = descriptors.map(d => d[0] === 'discover_artifacts' ? ['discover_artifacts', '3', 'read'] : d).concat([['save_world', '2', 'write']]);
const materialDescriptors = worldDescriptors.map(d => d[0] === 'discover_artifacts' ? ['discover_artifacts', '4', 'read'] : d[0] === 'read_artifact' ? ['read_artifact', '3', 'read'] : d).concat([['revise_story_materials', '2', 'write']]);
const matchesTools = (tools: ToolSnapshot[] | undefined, expected: string[][]) => tools?.length === expected.length
  && tools.every((t, i) => JSON.stringify([t.name, t.version, t.effect]) === JSON.stringify(expected[i]));
export function assertScopeTools(scope: ScopeV2, tools: ToolSnapshot[] | undefined) {
  if (scope.action === 'revise_story_materials' && !matchesTools(tools, materialDescriptors)) throw new TaskError(400, 'invalid_request');
  if (scope.target?.kind === 'world' && !matchesTools(tools, worldDescriptors) && !matchesTools(tools, materialDescriptors)) throw new TaskError(400, 'invalid_request');
}
export const isV2Tool = (tool: Pick<ToolSnapshot, 'name' | 'version'>) => [...descriptors, ...worldDescriptors, ...materialDescriptors].some(([name, version]) => tool.name === name && tool.version === version);
export function validateProtocol(tools: ToolSnapshot[] | undefined, protocol: unknown) {
  if (protocol === undefined) {
    if (tools?.some(t => isV2Tool(t) && t.version !== '1')) throw new TaskError(400, 'invalid_request');
    return;
  }
  if (protocol !== 2 || !matchesTools(tools, descriptors) && !matchesTools(tools, worldDescriptors) && !matchesTools(tools, materialDescriptors)) throw new TaskError(400, 'invalid_request');
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
  const tool = s.action === 'revise_story_materials' ? 'revise_story_materials' : s.target.kind === 'world' ? 'save_world' : s.target.kind === 'character' ? 'save_character' : s.action === 'create_chapter' ? 'create_chapter' : 'initialize_story';
  if (binding.tool.name !== tool || binding.tool.version !== '2' || binding.arguments.mode !== 'commit') return false;
  if (s.target.kind !== 'story') return !('assets' in v) && !('chapter' in v);
  if (s.action === 'revise_story_materials') {
    if (!validMaterials(s.material_members) || 'chapter' in v || v.content_hash !== v.draft_hash
      || !Array.isArray(v.assets) || v.assets.length !== s.material_members!.length) return false;
    const seen = new Set<string>();
    return v.assets.every(a => {
      if (!object(a) || !keys(a, ['asset_id', 'kind', 'mode', 'revision', 'content_hash']) || !text(a.asset_id) || seen.has(a.asset_id) || !hash(a.content_hash)) return false;
      seen.add(a.asset_id); const m = s.material_members!.find(m => m.asset_id === a.asset_id);
      return !!m && a.kind === m.kind && a.mode === m.mode && a.revision === String(m.base_version + 1);
    });
  }
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
  return object(a) && b && a.kind === b.kind && (b.kind !== 'story' ? a.asset_id === b.asset_id : a.story_id === b.story_id);
}
export function artifactV2(data: Record<string, unknown>, tool: string): boolean {
  const kind = tool === 'revise_story_materials' ? 'story_materials' : tool === 'save_world' ? 'world' : tool === 'save_character' ? 'character' : tool === 'initialize_story' ? 'story_initialization' : 'chapter';
  if (!keys(data, ['draft_id', 'draft_revision', 'draft_hash', 'group_id', 'ordinal', 'title', 'artifact_kind', 'parent_ref', 'members'])
    || !text(data.draft_id) || data.draft_revision !== '1' || !hash(data.draft_hash) || !text(data.group_id) || !text(data.title, 512)
    || !Number.isSafeInteger(data.ordinal) || Number(data.ordinal) < 1 || data.artifact_kind !== kind) return false;
  if ('parent_ref' in data && !candidateRef(data.parent_ref)) return false;
  if ('members' in data && (!['story_initialization', 'story_materials'].includes(kind) || !Array.isArray(data.members) || data.members.length > 8
    || data.members.some(m => !object(m) || !text(m.member_id) || !text(m.title, 512) || !['setting', 'outline', 'snapshot'].includes(String(m.kind))))) return false;
  if (kind === 'story_materials' && (!Array.isArray(data.members) || !data.members.length
    || new Set(data.members.map(m => m.member_id)).size !== data.members.length)) return false;
  return true;
}
function candidateRef(v: unknown): boolean {
  return object(v) && keys(v, ['type', 'group_id', 'draft_id', 'draft_revision', 'draft_hash', 'member_id'])
    && v.type === 'candidate' && text(v.group_id) && text(v.draft_id) && v.draft_revision === '1' && hash(v.draft_hash)
    && (!('member_id' in v) || text(v.member_id));
}
