import type { ToolSnapshot } from '../src/tool-types.ts';
export const hash = 'sha256:' + 'a'.repeat(64);
export const str = { type: 'string', minLength: 1, maxLength: 128 };
export const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const draft = { draft_id: 'draft-1', draft_revision: '1', draft_hash: hash };
const commit = obj({ mode: { type: 'string', enum: ['commit'] }, draft_id: str, draft_revision: str, draft_hash: str });
export const tools: ToolSnapshot[] = [
  ['library_vocabulary', '1', 'read'], ['search_library', '1', 'read'], ['read_library', '1', 'read'],
  ['search_assets', '2', 'read'], ['read_asset', '2', 'read'], ['discover_artifacts', '2', 'read'], ['read_artifact', '2', 'read'],
  ['save_character', '2', 'write'], ['initialize_story', '2', 'write'], ['create_chapter', '2', 'write'],
].map(([name, version, effect]) => ({ name: name!, version: version!, effect: effect as 'read' | 'write', description: name!,
  parameters: effect === 'read' ? obj({}) : { oneOf: [obj({ mode: { type: 'string', enum: ['draft'] }, title: str, body: str }), commit] } }));
export const scope = { protocol_version: 2, conversation_id: 'conversation', task_id: 'task', source_message_id: 'message',
  operation_id: 'op', phase: 'execute', refs_digest: hash, binding_digest: hash, authorization_id: 'grant',
  action: 'create_character', target: { kind: 'character', asset_id: 'character' } };
export const receipt = () => ({ protocol_version: 2, operation_id: 'op', status: 'committed', conversation_id: 'conversation', task_id: 'task',
  kind: 'character_created', target: { kind: 'character', asset_id: 'character' }, ...draft, content_hash: hash, revision: '1' });
export const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
