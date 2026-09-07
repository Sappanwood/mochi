import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';

test('HTTP verifies raw JWT through JWKS without Easy Auth and keeps failures private', async (t) => {
  const tenant = '11111111-1111-4111-8111-111111111111';
  const audience = '22222222-2222-4222-8222-222222222222';
  const client = '33333333-3333-4333-8333-333333333333';
  const principal = '44444444-4444-4444-8444-444444444444';
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const jwks = createHttpServer((_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  t.after(() => jwks.close());
  jwks.listen(0, '127.0.0.1');
  await once(jwks, 'listening');
  const auth = loadConfig({
    MOCHI_AUTH_MODE: 'entra', MOCHI_ENTRA_ISSUER: issuer, MOCHI_ENTRA_AUDIENCE: audience,
    MOCHI_ENTRA_ROLE: 'Mochi.Invoke',
    MOCHI_ENTRA_CALLERS: JSON.stringify({ alpha: { client_id: client, principal_id: principal } }),
  }).auth;
  const logs: unknown[] = [];
  let ready = false;
  const server = createServer({
    authenticate: createAuthenticator(auth, createRemoteJWKSet(new URL(`http://127.0.0.1:${(jwks.address() as AddressInfo).port}`))),
    isReady: () => ready,
    log: event => logs.push(event),
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  async function call(path: string, headers: Record<string, string | string[]> = {}, method = 'GET') {
    return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, headers, method }, res => {
        let body = '';
        res.setEncoding('utf8').on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      });
      req.on('error', reject).end();
    });
  }
  const signed = await new SignJWT({ tid: tenant, ver: '2.0', azp: client, oid: principal, roles: ['Mochi.Invoke'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience(audience)
    .setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(keys.privateKey);
  const authorization = `Bearer ${signed}`;
  assert.equal((await call('/health/live')).status, 200);
  assert.equal((await call('/health/ready')).status, 503);
  ready = true;
  assert.equal((await call('/health/ready')).status, 200);
  for (const path of ['/v1/sessions', '/admin/providers', '/unknown', '/health/live/extra']) {
    const response = await call(path, { 'x-ms-client-principal': 'forged-platform-identity', 'x-app-id': 'alpha' });
    assert.equal(response.status, 401);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
  }
  assert.equal((await call('/health/live', {}, 'POST')).status, 401);
  assert.equal((await call('/unknown', { authorization })).status, 404);
  assert.equal((await call('/admin/providers', { authorization })).status, 403);
  assert.equal((await call('/unknown?app_id=beta', { authorization })).status, 403);
  assert.equal((await call('/unknown', { authorization, 'x-app-id': 'beta' })).status, 403);
  assert.equal((await call('/unknown', { authorization: [authorization, authorization] })).status, 401);
  assert.equal((await call('/unknown?token=private-query', { authorization: 'Bearer private-token' })).status, 401);
  assert.ok(logs.length > 0);
  const serialized = JSON.stringify(logs);
  for (const secret of [signed, 'private-query', 'private-token', 'forged-platform-identity']) assert.ok(!serialized.includes(secret));
});

test('unexpected failures return generic errors and log no exception contents', async (t) => {
  const logs: unknown[] = [];
  const server = createServer({
    authenticate: async () => { throw new Error('secret credential'); },
    isReady: () => { throw new Error('private filesystem'); },
    log: event => logs.push(event),
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  for (const path of ['/unknown', '/health/ready']) {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      headers: { authorization: 'Bearer test' },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal_error' });
  }
  assert.ok(!JSON.stringify(logs).includes('secret'));
  assert.ok(!JSON.stringify(logs).includes('filesystem'));
});
