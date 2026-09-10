import assert from 'node:assert/strict';
import test from 'node:test';
import { AppTools } from '../src/app-tools.ts';
import type { ToolSnapshot } from '../src/tool-types.ts';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const branch = (type: string, fields: Record<string, unknown>) => object({ type: { type: 'string', enum: [type] }, ...fields });
const candidate = branch('candidate', { draft_id: { type: 'string' } });
const asset = branch('asset', { asset_id: { type: 'string' } });
const tool = (reference: Record<string, unknown>): ToolSnapshot => ({
  name: 'save_character', version: '2', effect: 'write', description: 'Exact reference validation',
  parameters: object({ ref: reference }),
});
const tools = new AppTools({});

test('nested reference oneOf validates exact type-discriminated objects and rejects mixed identities', () => {
  const schema = tool({ oneOf: [candidate, asset] });
  assert.doesNotThrow(() => tools.validateArguments(schema, { ref: { type: 'candidate', draft_id: 'draft' } }));
  assert.doesNotThrow(() => tools.validateArguments(schema, { ref: { type: 'asset', asset_id: 'asset' } }));
  for (const ref of [{ type: 'candidate', asset_id: 'asset' }, { type: 'asset', draft_id: 'draft' },
    { type: 'candidate', draft_id: 'draft', kind: 'character' }, { draft_id: 'draft' }]) {
    assert.throws(() => tools.validateArguments(schema, { ref }), /invalid_arguments/);
  }
});

test('nested unions reject ambiguous or malformed discriminants and unsupported keywords', () => {
  for (const variants of [[candidate, candidate], [candidate, object({ draft_id: { type: 'string' } })],
    [candidate, { ...asset, required: ['asset_id'] }],
    [candidate, object({ type: { type: 'string', enum: ['asset', 'candidate'] } })],
    [candidate, object({ type: { type: 'integer', enum: [1] } })],
    [candidate, { ...asset, $ref: 'unsupported' }]]) {
    assert.throws(() => tools.validateArguments(tool({ oneOf: variants }), { ref: {} }), /invalid_request/);
  }
  assert.throws(() => tools.validateArguments(tool({ anyOf: [candidate, asset] }), { ref: {} }), /invalid_request/);
});

test('root mode grammar is unchanged and nested unions retain branch and depth limits', () => {
  const draft = object({ mode: { type: 'string', enum: ['draft'] } });
  const commit = object({ mode: { type: 'string', enum: ['commit'] } });
  const root = { ...tool({}), parameters: { oneOf: [draft, commit] } };
  assert.doesNotThrow(() => tools.validateArguments(root, { mode: 'draft' }));
  assert.throws(() => tools.validateArguments({ ...root, parameters: { oneOf: [candidate, asset] } }, { type: 'candidate', draft_id: 'd' }), /invalid_request/);
  assert.throws(() => tools.validateArguments(tool({ oneOf: [draft, commit] }), { ref: { mode: 'draft' } }), /invalid_request/);
  assert.throws(() => tools.validateArguments(tool({ oneOf: Array.from({ length: 9 }, (_, i) => branch(String(i), {})) }), { ref: {} }), /invalid_request/);
  let deep: Record<string, unknown> = { oneOf: [candidate, asset] };
  for (let i = 0; i < 8; i++) deep = object({ child: deep });
  assert.throws(() => tools.validateArguments(tool(deep), { ref: {} }), /invalid_request/);
});
