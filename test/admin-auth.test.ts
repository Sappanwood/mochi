import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadAdminConfig, adminAuthenticator } from '../src/admin-auth.ts';

const tenant = '11111111-1111-4111-8111-111111111111';
const audience = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const oid = '44444444-4444-4444-8444-444444444444';
const env = {
  MOCHI_ENTRA_ISSUER: `https://login.microsoftonline.com/${tenant}/v2.0`,
  MOCHI_ADMIN_AUDIENCE: audience, MOCHI_ADMIN_CLIENT_ID: client,
  MOCHI_ADMIN_OID: oid, MOCHI_ADMIN_ORIGIN: 'https://admin.example.com',
  MOCHI_AUTH_DIR: '/var/lib/mochi/auth',
};

test('admin auth permits only the configured person and delegated client/scope', async () => {
  const config = loadAdminConfig(env);
  const keys = await generateKeyPair('RS256');
  const authenticate = adminAuthenticator(config, createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }));
  const claims = { iss: env.MOCHI_ENTRA_ISSUER, aud: audience, azp: client, oid, tid: tenant,
    ver: '2.0', scp: 'Mochi.Manage', exp: Math.floor(Date.now() / 1000) + 300, nbf: 1, iat: 1 };
  const sign = (patch: Record<string, unknown>) => new SignJWT({ ...claims, ...patch })
    .setProtectedHeader({ alg: 'RS256' }).sign(keys.privateKey);
  assert.equal((await authenticate(`Bearer ${await sign({})}`)).oid, oid);
  for (const [patch, status] of [
    [{ oid: client }, 403], [{ azp: audience }, 403], [{ tid: oid }, 401],
    [{ scp: undefined, roles: ['Mochi.Invoke'], idtyp: 'app' }, 403],
    [{ scp: 'Mochi.ManageElse' }, 403], [{ idtyp: 'app' }, 403],
    [{ aud: client }, 401], [{ iss: 'https://evil.test' }, 401], [{ exp: 1 }, 401],
  ] as const) await assert.rejects(() => sign(patch).then(token => authenticate(`Bearer ${token}`)), { status });
  await assert.rejects(() => authenticate(undefined), { status: 401 });
});

test('admin configuration rejects incomplete or unsafe parameters', () => {
  for (const patch of [
    { MOCHI_ADMIN_OID: '' }, { MOCHI_ADMIN_ORIGIN: 'http://public.test' },
    { MOCHI_ADMIN_ORIGIN: 'https://admin.example.com/path' }, { MOCHI_ADMIN_ORIGIN: 'https://user:pass@admin.example.com' },
    { MOCHI_ADMIN_CLIENT_ID: '' }, { MOCHI_AUTH_DIR: 'relative' },
    { MOCHI_ENTRA_ISSUER: 'https://login.microsoftonline.com/common/v2.0' }, { PORT: '70000' },
  ]) assert.throws(() => loadAdminConfig({ ...env, ...patch }), /invalid_admin_configuration/);
});
