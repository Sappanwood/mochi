import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadConfig } from '../src/config.ts';
import { createAuthenticator } from '../src/auth.ts';

const tenant = '11111111-1111-4111-8111-111111111111';
const audience = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const principal = '44444444-4444-4444-8444-444444444444';
const clientB = '55555555-5555-4555-8555-555555555555';
const principalB = '66666666-6666-4666-8666-666666666666';
const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
const env = {
  MOCHI_AUTH_MODE: 'entra', MOCHI_ENTRA_ISSUER: issuer,
  MOCHI_ENTRA_AUDIENCE: audience, MOCHI_ENTRA_ROLE: 'Mochi.Invoke',
  MOCHI_ENTRA_CALLERS: JSON.stringify({
    alpha: { client_id: client, principal_id: principal },
    beta: { client_id: clientB, principal_id: principalB },
  }),
};
const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
const authenticate = createAuthenticator(loadConfig(env).auth, createLocalJWKSet({ keys: [jwk] }));
const claims = {
  iss: issuer, aud: audience, tid: tenant, ver: '2.0', azp: client, oid: principal,
  roles: ['Mochi.Invoke'], iat: Math.floor(Date.now() / 1000),
  nbf: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 300,
};
async function token(changes: Record<string, unknown> = {}, key = keys.privateKey) {
  return new SignJWT({ ...claims, ...changes }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key);
}

test('signed app-only identities map to distinct server-owned app IDs', async () => {
  assert.deepEqual(await authenticate(`Bearer ${await token()}`), { appId: 'alpha' });
  assert.deepEqual(await authenticate(`Bearer ${await token({ azp: clientB, oid: principalB })}`), { appId: 'beta' });
});

for (const [name, changes, status] of [
  ['expired', { exp: 1 }, 401], ['future', { nbf: claims.exp + 100 }, 401],
  ['issuer', { iss: `${issuer}/evil` }, 401], ['audience', { aud: client }, 401],
  ['tenant', { tid: audience }, 401], ['version', { ver: '1.0' }, 401],
  ['missing expiry', { exp: undefined }, 401], ['missing not-before', { nbf: undefined }, 401],
  ['delegated', { scp: 'Mochi.Invoke' }, 403], ['empty delegated scope', { scp: '' }, 403],
  ['user token', { idtyp: 'user' }, 403], ['missing role', { roles: [] }, 403],
  ['wrong role shape', { roles: 'Mochi.Invoke' }, 403], ['unknown client', { azp: audience }, 403],
  ['wrong principal', { oid: principalB }, 403], ['missing principal', { oid: undefined }, 403],
] as const) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(() => token(changes).then(t => authenticate(`Bearer ${t}`)), { status });
  });
}

test('rejects absent, malformed, forged and disallowed-algorithm tokens', async () => {
  const otherKeys = await generateKeyPair('RS256');
  const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
  for (const value of [undefined, 'Basic abc', 'Bearer garbage', `Bearer ${await token({}, otherKeys.privateKey)}`, `Bearer ${hs}`]) {
    await assert.rejects(() => authenticate(value), { status: 401 });
  }
});

test('configuration rejects incomplete, ambiguous and unsafe identity mappings', () => {
  for (const changes of [
    { MOCHI_AUTH_MODE: undefined }, { MOCHI_AUTH_MODE: 'none' },
    { MOCHI_ENTRA_AUDIENCE: `api://${audience}` }, { MOCHI_ENTRA_ISSUER: 'https://attacker.test/v2.0' },
    { MOCHI_ENTRA_ISSUER: 'https://login.microsoftonline.com/common/v2.0' },
    { MOCHI_ENTRA_ROLE: 'Other' }, { MOCHI_ENTRA_CALLERS: '{}' }, { MOCHI_ENTRA_CALLERS: 'null' },
    { MOCHI_ENTRA_CALLERS: '{bad' }, { MOCHI_ENTRA_CALLERS: '[]' },
    { MOCHI_ENTRA_CALLERS: JSON.stringify({ '../bad': { client_id: client, principal_id: principal } }) },
    { MOCHI_ENTRA_CALLERS: JSON.stringify({ a: { client_id: client, principal_id: principal }, b: { client_id: client, principal_id: principalB } }) },
    { MOCHI_ENTRA_CALLERS: JSON.stringify({ a: { client_id: client, principal_id: principal }, b: { client_id: clientB, principal_id: principal } }) },
    { MOCHI_ENTRA_CALLERS: JSON.stringify({ a: { client_id: 'invalid', principal_id: principal } }) },
    { PORT: '8080oops' }, { PORT: '0' }, { PORT: '65536' },
  ]) assert.throws(() => loadConfig({ ...env, ...changes }), /Invalid configuration/);
  assert.equal(loadConfig(env).port, 8080);
  assert.equal(loadConfig(env).auth.tenant, tenant);
});
