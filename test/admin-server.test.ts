import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createAdminServer } from '../src/admin-server.ts';
import { AdminControl } from '../src/admin-control.ts';
import { AccessError } from '../src/auth.ts';
import type { AdminConfig } from '../src/admin-auth.ts';

test('admin HTTP requires person token, origin and session; secrets never enter responses or logs', async (t) => {
  const saved: string[] = []; const logs: object[] = []; let refreshes = 0;
  const control = new AdminControl({
    login: async (_p, interaction) => { saved.push(await interaction.prompt({ type: 'secret', message: 'key' })); },
    refreshOpenAI: async () => { refreshes++; }, logout: async () => {}, status: async () => [], models: () => [],
  }, new AbortController().signal);
  const origin = 'https://admin.example.com';
  const server = createAdminServer({
    config: { origin, clientId: 'public-client', audience: 'audience', tenant: 'tenant', scope: 'Mochi.Manage' } as AdminConfig,
    authenticate: async header => { if (header !== 'Bearer person') throw new AccessError(401); return { oid: 'person', expires: Date.now() + 600000 }; },
    control, isReady: () => true, assets: new Map([['/', { type: 'text/html', body: '<h1>Mochi</h1>' }]]),
    log: entry => logs.push(entry),
  });
  t.after(async () => { server.closeAllConnections(); server.close(); await control.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(path: string, method = 'GET', body?: object, extra = {}) {
    return fetch(base + path, { method, headers: {
      authorization: 'Bearer person', origin, 'content-type': 'application/json', 'x-mochi-request': '1', ...extra,
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/admin/config')).status, 200);
  for (const path of ['/admin/../admin/config', '/admin/%2e%2e/admin/config', '/admin\\config', '//admin/config', '/admin/%2fconfig']) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(base, { path }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 400, path);
  }
  assert.equal((await fetch(base + '/admin/providers')).status, 401);
  assert.equal((await call('/admin/session', 'POST', {}, { authorization: 'Bearer app-only' })).status, 401);
  assert.equal((await call('/admin/session', 'POST', {}, { origin: 'https://evil.example' })).status, 403);
  const sessionResponse = await call('/admin/session', 'POST', {});
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json() as { id: string };
  const headers = { 'x-mochi-session': session.id };
  assert.equal((await call('/admin/providers', 'GET', undefined, headers)).status, 200);
  assert.equal((await call('/admin/providers?key=private', 'GET', undefined, headers)).status, 400);
  const refreshPath = '/admin/providers/openai-codex/refresh';
  assert.equal((await call(refreshPath, 'POST', {}, { ...headers, authorization: 'Bearer app-only' })).status, 401);
  assert.equal((await call(refreshPath, 'POST', {}, { ...headers, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(refreshPath, 'POST', {})).status, 401);
  assert.equal(refreshes, 0);
  assert.equal((await call(refreshPath, 'POST', { force: true }, headers)).status, 400);
  const refreshed = await call(refreshPath, 'POST', {}, headers);
  assert.equal(refreshed.status, 200);
  assert.deepEqual(await refreshed.json(), { ok: true });
  assert.equal(refreshes, 1);
  const save = await call('/admin/providers/deepseek/key', 'POST', { key: 'private-api-key' }, headers);
  assert.equal(save.status, 200); assert.deepEqual(saved, ['private-api-key']);
  assert.ok(!(await save.text()).includes('private-api-key'));
  assert.equal((await call('/admin/providers/deepseek/key', 'POST', { key: 'x'.repeat(20000) }, headers)).status, 413);
  assert.equal((await call('/admin/oauth/forged', 'GET', undefined, headers)).status, 403);
  assert.equal((await call('/admin/session', 'DELETE', {}, headers)).status, 200);
  assert.equal((await call('/admin/providers', 'GET', undefined, headers)).status, 401);
  assert.ok(!JSON.stringify(logs).includes('private'));
});
