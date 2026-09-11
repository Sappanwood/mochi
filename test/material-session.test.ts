import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppTools, formalCommit } from '../src/app-tools.ts';
import { scopeV2, validateProtocol, assertScopeTools, receiptV2, artifactV2 } from '../src/free-session.ts';
import { tools, worldTools, scope, receipt, draft, hash } from './free-session-fixture.ts';
const materials = worldTools.map(t => ({ ...t, version: t.name === 'discover_artifacts' ? '4' : t.name === 'read_artifact' ? '3' : t.version }));
materials.push({ ...worldTools[10]!, name: 'revise_story_materials' });
const members = [
  { key: 'new', kind: 'snapshot', mode: 'create', asset_id: 'new', base_revision: null, base_version: 0 },
  { key: 'setting', kind: 'setting', mode: 'update', asset_id: 'setting', base_revision: 'etag', base_version: 2 },
];
const s = { ...scope, action: 'revise_story_materials', target: { kind: 'story', story_id: 'story' }, material_members: members };
const binding = { tool: { name: 'revise_story_materials', version: '2' }, scope: s, arguments: { mode: 'commit', ...draft } };
const saved = () => ({ ...receipt(), kind: 'story_materials_saved', target: s.target,
  assets: members.map(m => ({ asset_id: m.asset_id, kind: m.kind, mode: m.mode, revision: String(m.base_version + 1), content_hash: hash })) });
test('materials exact snapshot and scope preserve both old capabilities', () => {
  for (const set of [tools, worldTools, materials]) assert.doesNotThrow(() => validateProtocol(set, 2));
  const parsed = scopeV2(s); assert.doesNotThrow(() => assertScopeTools(parsed, materials));
  for (const old of [tools, worldTools]) assert.throws(() => assertScopeTools(parsed, old), /invalid_request/);
  assert.doesNotThrow(() => assertScopeTools(scopeV2({ ...scope, action: 'create_world', target: { kind: 'world', asset_id: 'w' } }), materials));
  for (const set of [materials.slice(0, 11), [...worldTools, materials[11]!], [...materials].reverse()])
    assert.throws(() => validateProtocol(set, 2));
  assert.throws(() => validateProtocol(materials, undefined));
  for (const bad of [[], [...members, members[0]], members.map(m => ({ ...m, kind: 'chapter' })),
    members.map(m => ({ ...m, mode: 'create' })), members.map(m => ({ ...m, base_version: -1 }))])
    assert.throws(() => scopeV2({ ...s, material_members: bad }), /invalid_request/);
  assert.throws(() => scopeV2({ ...s, phase: 'resolve' }));
  assert.throws(() => scopeV2({ ...scope, material_members: members }));
  const { material_members: _members, ...missing } = s; assert.throws(() => scopeV2(missing));
});
test('materials receipts must exactly cover scope members and new versions', () => {
  assert.equal(formalCommit(binding.tool, binding.arguments), true);
  assert.equal(receiptV2(saved(), 'op', binding as never), true);
  for (const bad of [
    { ...saved(), assets: saved().assets.slice(1) },
    { ...saved(), assets: [...saved().assets, saved().assets[0]] },
    { ...saved(), assets: saved().assets.map(a => ({ ...a, revision: '2' })) },
    { ...saved(), assets: saved().assets.map(a => ({ ...a, asset_id: 'other' })) },
    { ...saved(), assets: saved().assets.map(a => ({ ...a, mode: 'update' })) },
    { ...saved(), assets: saved().assets.map(a => ({ ...a, content_hash: 'bad' })) },
    { ...saved(), target: { kind: 'story', story_id: 'other' } },
    { ...saved(), chapter: { chapter_id: 'chapter', revision: '1', content_hash: hash } },
    { ...saved(), draft_id: 'other' },
  ]) assert.equal(receiptV2(bad, 'op', binding as never), false);
  assert.equal(receiptV2(saved(), 'op', { ...binding, tool: { name: 'initialize_story', version: '2' } } as never), false);
});
test('materials candidate directories validate member identity and exact limits', () => {
  const data = { ...draft, group_id: 'g', ordinal: 1, title: 'Materials', artifact_kind: 'story_materials',
    members: members.map(m => ({ member_id: m.asset_id, title: m.key, kind: m.kind })) };
  assert.equal(artifactV2(data, 'revise_story_materials'), true);
  assert.equal(artifactV2({ ...data, members: [] }, 'revise_story_materials'), false);
  assert.equal(artifactV2({ ...data, members: [...data.members, data.members[0]] }, 'revise_story_materials'), false);
  assert.equal(artifactV2({ ...data, members: Array.from({ length: 9 }, (_, i) => ({ member_id: String(i), title: 'x', kind: 'snapshot' })) }, 'revise_story_materials'), false);
});
test('allowlist holds historical descriptors up to 32 without changing session limit', () => {
  const descriptors = Array.from({ length: 32 }, (_, i) => ({ name: 'tool_' + i, version: '1', effect: 'read' as const }));
  const config = (list: typeof descriptors) => ({ write: { endpoint: 'https://write.invalid/tools', operations_endpoint: 'https://write.invalid/operations', audience: 'api://write', tools: list } });
  const app = new AppTools(config(descriptors));
  assert.throws(() => new AppTools(config([...descriptors, { ...descriptors[0]!, name: 'tool_32' }])));
  assert.throws(() => app.validate('write', Array.from({ length: 17 }, (_, i) => ({ ...tools[0], name: 'tool_' + i })), 2));
});
