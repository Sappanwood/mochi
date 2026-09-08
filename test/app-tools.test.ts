import assert from 'node:assert/strict';
import test from 'node:test';
import { AppTools } from '../src/app-tools.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { CallbackRequest, ToolBinding, ToolSnapshot } from '../src/tool-types.ts';
import { initializationTool, initializationReceipt, initializationRef } from './initialization-fixture.ts';

const read: ToolSnapshot = { name: 'read_asset', version: '1', effect: 'read', description: 'Read exact story revision',
  parameters: { type: 'object', properties: { asset_id: { type: 'string', minLength: 1, maxLength: 128 }, revision: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['asset_id', 'revision'], additionalProperties: false } };
const binding: ToolBinding = { endpoint: 'https://write.example/api/agent/tools', operations_endpoint: 'https://write.example/api/agent/operations', audience: 'api://write-api', tools: [{ name: 'read_asset', version: '1', effect: 'read' }] };

test('tool registration rejects unsafe endpoints and scopes before any network call', () => {
  for (const endpoint of ['http://write.example/tools', 'https://user:secret@write.example/tools', 'https://write.example/tools?token=secret']) {
    assert.throws(() => new AppTools({ write: { ...binding, endpoint } }));
  }
  assert.throws(() => new AppTools({ write: { ...binding, operations_endpoint: 'https://other.example/operations' } }));
});

function request(): CallbackRequest {
  return { protocol_version: 1, app_id: 'write', session_id: 's', run_id: 'r', task_id: 't',
    scope: { story_id: 'story', source_message_id: 'm', operation_id: 'op' }, tool: { name: 'read_asset', version: '1' },
    tool_call_id: 'call', invocation_id: 'invocation', arguments: { asset_id: 'a', revision: '1' } };
}
const committed = { operation_id: 'op', status: 'committed', story_id: 'story', chapter_id: 'chapter', revision: '1', content_hash: 'sha256:' + 'a'.repeat(64) };

test('real HTTP callback injects app identity and token, and can look up a preallocated operation', async () => {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer isolated-token');
    seen.push(req.url!);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ protocol_version: 1, operation_id: 'op', status: 'committed', receipt: committed })); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(value.app_id, 'write'); assert.equal(value.scope.operation_id, 'op');
    assert.ok(!JSON.stringify(value).includes('isolated-token'));
    res.end(JSON.stringify({ protocol_version: 1, invocation_id: value.invocation_id, outcome: 'ok', data: { asset_id: 'a', content: 'story text' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const tools = new AppTools({ write: { ...binding, endpoint: origin + '/tools', operations_endpoint: origin + '/operations' } }, {
      allowLoopback: true, token: async (audience) => { assert.equal(audience, binding.audience); return 'isolated-token'; },
    });
    const response = await tools.invoke('write', request(), new AbortController().signal);
    assert.equal(response.outcome, 'ok');
    assert.equal((await tools.operation('write', 'op', new AbortController().signal)).status, 'committed');
    assert.deepEqual(seen, ['/tools', '/operations/op']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('callback failures preserve uncertainty and never accept forged invocation or operation receipts', async () => {
  let value: unknown;
  const tools = new AppTools({ write: { ...binding, tools: [...binding.tools, { name: 'create_chapter', version: '1', effect: 'write' }] } }, {
    token: async () => 'test-token', fetch: async (_url, init) => {
      assert.equal(init?.redirect, 'error');
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    },
  });
  const signal = new AbortController().signal;
  for (const bad of [null, { protocol_version: 1, invocation_id: 'wrong', outcome: 'ok', data: {} },
    { protocol_version: 1, invocation_id: 'invocation', outcome: 'error', error: { code: 'private exception', retryable: false } },
    { protocol_version: 1, invocation_id: 'invocation', outcome: 'ok', data: {}, receipt: committed }]) {
    value = bad; await assert.rejects(tools.invoke('write', request(), signal), /tool_transport_failed/);
  }
  const commit = { ...request(), tool: { name: 'create_chapter', version: '1' }, arguments: { mode: 'commit', draft_id: 'd', draft_revision: '1', draft_hash: committed.content_hash } };
  for (const receipt of [undefined, { ...committed, operation_id: 'wrong' }, { ...committed, story_id: 'other-story' }]) {
    value = { protocol_version: 1, invocation_id: 'invocation', outcome: 'ok', data: {}, receipt };
    await assert.rejects(tools.invoke('write', commit, signal), /tool_transport_failed/);
  }
  value = { protocol_version: 1, invocation_id: 'invocation', outcome: 'ok', data: {}, receipt: committed };
  assert.equal((await tools.invoke('write', commit, signal)).outcome, 'ok');
  value = { protocol_version: 1, operation_id: 'other', status: 'committed', receipt: committed };
  await assert.rejects(tools.operation('write', 'op', signal), /tool_transport_failed/);
  await assert.rejects(tools.operation('write', '..', signal), /tool_transport_failed/);
});

test('transport bounds actual streamed bytes, rejects non-JSON responses and honours cancellation', async () => {
  let calls = 0;
  let response = new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } });
  const tools = new AppTools({ write: binding }, { token: async () => 'token', fetch: async () => { calls++; return response; } });
  await assert.rejects(tools.invoke('write', request(), new AbortController().signal), /tool_transport_failed/);
  response = new Response('<html>private error</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(tools.invoke('write', request(), new AbortController().signal), /tool_transport_failed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tools.invoke('write', request(), controller.signal), /tool_transport_failed/);
  assert.equal(calls, 2);
});

test('only registered snapshots can be enabled, with canonical hashes and no legacy change', () => {
  const tools = new AppTools({ write: binding });
  assert.equal(tools.validate('write', undefined), undefined);
  assert.equal(tools.validate('write', []), undefined);
  assert.throws(() => tools.validate('other', [read]), /tool_version_unavailable/);
  const first = tools.validate('write', [read]) as { tool_snapshot_hash: string };
  const second = tools.validate('write', [{ ...read, parameters: { required: ['asset_id', 'revision'], additionalProperties: false, properties: read.parameters.properties, type: 'object' } }]) as { tool_snapshot_hash: string };
  assert.match(first.tool_snapshot_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.tool_snapshot_hash, second.tool_snapshot_hash);
  assert.throws(() => tools.validate('write', [{ ...read, version: '2' }]), /tool_version_unavailable/);
  assert.throws(() => tools.validate('write', [read, read]), /invalid_request/);
});

test('tool schema rejects unknown keywords and arguments rather than trusting generated JSON', () => {
  const tools = new AppTools({ write: binding });
  assert.throws(() => tools.validate('write', [{ ...read, parameters: { ...read.parameters, $ref: 'https://evil.example/schema' } }]), /invalid_request/);
  assert.throws(() => tools.validateArguments(read, { asset_id: 'a' }), /invalid_arguments/);
  assert.throws(() => tools.validateArguments(read, { asset_id: 'a', revision: '1', authorized: true }), /invalid_arguments/);
  assert.doesNotThrow(() => tools.validateArguments(read, { asset_id: 'a', revision: '1' }));
});

test('bounded array schemas accept exact boundaries and reject unbounded, tuple and nested invalid values', () => {
  const tools = new AppTools({ write: { ...binding, tools: [{ name: initializationTool.name, version: '1', effect: 'write' }] } });
  assert.ok(tools.validate('write', [initializationTool]));
  const withArray = (array: Record<string, unknown>): ToolSnapshot => ({ ...initializationTool, parameters: {
    type: 'object', properties: { values: array }, required: ['values'], additionalProperties: false } });
  const bounded = { type: 'array', items: { type: 'string', maxLength: 3 }, minItems: 1, maxItems: 16 };
  const tool = withArray(bounded);
  assert.doesNotThrow(() => tools.validateArguments(tool, { values: Array(16).fill('中') }));
  for (const values of [[], Array(17).fill('a'), [1], ['long'], {}]) {
    assert.throws(() => tools.validateArguments(tool, { values }), /invalid_arguments/);
  }
  for (const array of [{ ...bounded, maxItems: undefined }, { ...bounded, maxItems: 17 }, { ...bounded, minItems: 17 },
    { ...bounded, minItems: -1 }, { ...bounded, maxItems: 1.5 }, { ...bounded, items: [bounded.items] }, { ...bounded, uniqueItems: true }]) {
    assert.throws(() => tools.validate('write', [withArray(array)]), /invalid_request/);
  }
});

test('initialization receipt union accepts both outcomes and binds exact tool version, story, OP and draft', async () => {
  let receipt: unknown;
  const tools = new AppTools({ write: { ...binding, tools: [{ name: initializationTool.name, version: '1', effect: 'write' },
    { name: 'create_chapter', version: '1', effect: 'write' }] } }, {
    token: async () => 'token', fetch: async () => new Response(JSON.stringify({ protocol_version: 1, invocation_id: 'invocation', outcome: 'ok', data: {}, receipt }), { headers: { 'content-type': 'application/json' } }),
  });
  const req = { ...request(), tool: { name: 'initialize_story', version: '1' }, arguments: { mode: 'commit', ...initializationRef } };
  const signal = new AbortController().signal;
  for (const chapter of [false, true]) {
    receipt = initializationReceipt(chapter);
    assert.equal((await tools.invoke('write', req, signal)).outcome, 'ok');
  }
  const valid = initializationReceipt();
  for (const bad of [committed, { ...valid, chapter: initializationReceipt(true).chapter },
    { ...valid, kind: 'first_chapter_saved' }, { ...valid, kind: 'arbitrary_write' }, { ...valid, operation_id: 'other' },
    { ...valid, story_id: 'other' }, { ...valid, draft_id: 'other' }, { ...valid, draft_revision: '2' },
    { ...valid, draft_hash: 'sha256:' + 'b'.repeat(64) }, { ...valid, assets: Array(9).fill(valid.assets[0]) },
    { ...valid, content_hash: 'sha256:' + 'b'.repeat(64) },
    { ...valid, assets: [{ ...valid.assets[0], kind: 'chapter' }] }, { ...valid, assets: [{ ...valid.assets[0], extra: true }] },
    { ...valid, assets: [valid.assets[0], valid.assets[0]] }, { ...valid, unknown: true }]) {
    receipt = bad; await assert.rejects(tools.invoke('write', req, signal), /tool_transport_failed/);
  }
  receipt = valid;
  await assert.rejects(tools.invoke('write', { ...req, tool: { name: 'create_chapter', version: '1' } }, signal), /tool_transport_failed/);
  await assert.rejects(tools.invoke('write', { ...req, arguments: { mode: 'draft' } }, signal), /tool_transport_failed/);
  const future = new AppTools({ write: { ...binding, tools: [{ name: 'initialize_story', version: '2', effect: 'write' }] } }, {
    token: async () => 'token', fetch: async () => new Response(JSON.stringify({ protocol_version: 1, invocation_id: 'invocation', outcome: 'ok', data: {}, receipt }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(future.invoke('write', { ...req, tool: { name: 'initialize_story', version: '2' } }, signal), /tool_transport_failed/);
});
