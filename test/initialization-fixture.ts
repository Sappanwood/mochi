import type { ToolSnapshot } from '../src/tool-types.ts';

export const initializationHash = 'sha256:' + 'a'.repeat(64);
const string = { type: 'string', minLength: 1, maxLength: 128 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const initializationTool: ToolSnapshot = {
  name: 'initialize_story', version: '1', effect: 'write', description: 'Create exact initialization drafts and commit one package',
  parameters: { oneOf: [
    object({ mode: { type: 'string', enum: ['draft'] }, title: string,
      assets: { type: 'array', items: object({ kind: { type: 'string', enum: ['setting', 'outline', 'snapshot'] }, title: string, body: string }), maxItems: 8 },
      chapter: object({ title: string, body: string }) }, ['mode', 'title', 'assets']),
    object({ mode: { type: 'string', enum: ['commit'] }, draft_id: string, draft_revision: string, draft_hash: string }),
  ] },
};
export const initializationRef = { draft_id: 'init-draft', draft_revision: '1', draft_hash: initializationHash };
export function initializationReceipt(chapter = false) {
  return { operation_id: 'op', status: 'committed', story_id: 'story', kind: chapter ? 'first_chapter_saved' : 'story_initialized',
    revision: '1', content_hash: initializationHash, ...initializationRef,
    assets: [{ asset_id: 'setting', kind: 'setting', revision: '1', content_hash: initializationHash }],
    ...(chapter ? { chapter: { chapter_id: 'chapter', revision: '1', content_hash: initializationHash } } : {}) };
}
