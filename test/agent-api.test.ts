import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';
import { TaskStore } from '../src/task-store.ts';
import { Tasks } from '../src/tasks.ts';

test('two real HTTP/JWT clients isolate sessions, reconnect results/events and reject malformed writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-http-')); const store = await TaskStore.open(root);
  const sent: string[] = [];
  const tasks = new Tasks(store, { send: async id => { sent.push(id); } }, () => [
    { provider: 'deepseek', id: 'test', name: 'test', auth: 'api_key', context_window: 10000, max_output_tokens: 1000 },
  ]);
  const tenant = '11111111-1111-4111-8111-111111111111'; const audience = '22222222-2222-4222-8222-222222222222';
  const alpha = '33333333-3333-4333-8333-333333333333'; const beta = '44444444-4444-4444-8444-444444444444';
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const keys = await generateKeyPair('RS256'); const jwk = { ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const auth = loadConfig({ MOCHI_AUTH_MODE: 'entra', MOCHI_ENTRA_ISSUER: issuer, MOCHI_ENTRA_AUDIENCE: audience,
    MOCHI_ENTRA_ROLE: 'Mochi.Invoke', MOCHI_ENTRA_CALLERS: JSON.stringify({ alpha: { client_id: alpha, principal_id: alpha }, beta: { client_id: beta, principal_id: beta } }) }).auth;
  const logs: unknown[] = [];
  const server = createServer({ authenticate: createAuthenticator(auth, createLocalJWKSet({ keys: [jwk] })), tasks, isReady: () => true, log: event => logs.push(event) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await tasks.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function token(client: string) {
    return new SignJWT({ tid: tenant, ver: '2.0', azp: client, oid: client, roles: ['Mochi.Invoke'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience(audience).setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(keys.privateKey);
  }
  const tokens = { alpha: await token(alpha), beta: await token(beta) };
  const call = (path: string, body?: object, identity: 'alpha' | 'beta' = 'alpha', headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${tokens[identity]}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await call('/v1/models')).status, 200);
  const sessionResponse = await call('/v1/sessions', { system_prompt: 'private-prefix' }); assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json() as { session_id: string };
  assert.equal((await call(`/v1/sessions/${session.session_id}`, undefined, 'beta')).status, 403);
  const input = { idempotency_key: 'stable-key', provider: 'deepseek', model: 'test', prompt: 'private-input' };
  const submitted = await call(`/v1/sessions/${session.session_id}/runs`, input); assert.equal(submitted.status, 202);
  const run = await submitted.json() as { run_id: string };
  assert.equal(sent.length, 1);
  assert.equal((await call(`/v1/sessions/${session.session_id}/runs`, { ...input, prompt: 'different' })).status, 409);
  assert.equal((await call(`/v1/runs/${run.run_id}/events?after=0`, undefined, 'beta')).status, 403);
  await tasks.execute(run.run_id, async (_input, _signal, delta) => { await delta('complete'); return { text: 'complete', usage: null }; });
  const recovered = await (await call('/v1/runs/by-key?key=stable-key')).json() as { status: string; result: { text: string } };
  assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.result.text, 'complete');
  const events = await (await call(`/v1/runs/${run.run_id}/events?after=2`, undefined, 'alpha', { accept: 'text/event-stream' })).text();
  assert.ok(events.includes('id: 3\nevent: text_delta')); assert.ok(events.includes('"status":"succeeded"'));
  assert.ok(!events.includes('id: 1\n')); assert.equal((await call(`/v1/runs/${run.run_id}/events?after=999`)).status, 400);
  assert.equal((await call(`/v1/runs/${run.run_id}/cancel`, {})).status, 200);
  assert.equal((await call('/v1/sessions', { app_id: 'beta' })).status, 400);
  assert.equal((await call('/v1/sessions', {}, 'alpha', { 'content-type': 'text/plain' })).status, 415);
  assert.ok(!JSON.stringify(logs).includes('private-'));
});

test('unified listener preserves anonymous admin shell and separate admin authentication', async t => {
  const { createAdminServer } = await import('../src/admin-server.ts');
  const { AdminControl } = await import('../src/admin-control.ts');
  const { AccessError } = await import('../src/auth.ts');
  const control = new AdminControl({ login: async () => {}, refreshOpenAI: async () => {}, logout: async () => {}, status: async () => [], models: () => [] }, new AbortController().signal);
  const config = { origin: 'https://admin.example.com', clientId: 'public', audience: 'admin', tenant: 'tenant', scope: 'Mochi.Manage', issuer: '', oid: '', authDir: '', port: 8080 };
  const admin = createAdminServer({ config, control, authenticate: async header => {
    if (header !== 'Bearer person') throw new AccessError(401); return { oid: 'person', expires: Date.now() + 60000 };
  }, isReady: () => true, assets: new Map([['/', { type: 'text/html', body: '<h1>Admin</h1>' }]]), log: () => {} });
  const server = createServer({ authenticate: async header => { if (header !== 'Bearer app') throw new AccessError(401); return { appId: 'alpha' }; },
    isReady: () => true, adminHandler: admin.listeners('request')[0] as import('node:http').RequestListener, log: () => {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await control.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(base + '/')).status, 200); assert.equal((await fetch(base + '/admin/config')).status, 200);
  assert.equal((await fetch(base + '/admin/session', { method: 'POST', headers: { authorization: 'Bearer app', 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/admin/session', { method: 'POST', headers: { authorization: 'Bearer person', 'content-type': 'application/json', origin: config.origin, 'x-mochi-request': '1' }, body: '{}' })).status, 201);
  assert.equal((await fetch(base + '/v1/models', { headers: { authorization: 'Bearer person' } })).status, 401);
});
