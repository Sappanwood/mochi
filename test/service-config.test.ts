import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadServiceConfig } from '../src/service-config.ts';

const id = '11111111-1111-4111-8111-111111111111';
const env = { MOCHI_AUTH_MODE: 'entra', MOCHI_ENTRA_ISSUER: `https://login.microsoftonline.com/${id}/v2.0`, MOCHI_ENTRA_AUDIENCE: id,
  MOCHI_ENTRA_ROLE: 'Mochi.Invoke', MOCHI_ENTRA_CALLERS: JSON.stringify({ alpha: { client_id: id, principal_id: id } }),
  MOCHI_AUTH_DIR: '/tmp/mochi-auth', MOCHI_DATA_DIR: '/tmp/mochi-data' };
const admin = { MOCHI_ADMIN_CLIENT_ID: id, MOCHI_ADMIN_AUDIENCE: id, MOCHI_ADMIN_OID: id, MOCHI_ADMIN_ORIGIN: 'https://admin.example.com' };

test('API-only startup configuration retains business authentication and one auth owner without admin routes', () => {
  const config = loadServiceConfig(env); assert.equal(config.admin, undefined); assert.equal(config.authDir, env.MOCHI_AUTH_DIR);
  assert.equal(config.auth.callers.get(id)?.appId, 'alpha'); assert.equal(config.dataDir, env.MOCHI_DATA_DIR);
});
test('unified startup uses same auth directory and keeps independent personal audience configuration', () => {
  const config = loadServiceConfig({ ...env, ...admin }); assert.equal(config.admin?.authDir, config.authDir);
  assert.equal(config.admin?.scope, 'Mochi.Manage'); assert.equal(config.auth.role, 'Mochi.Invoke');
});
test('any partial admin configuration or missing business auth fails instead of downgrading', () => {
  for (const [key, value] of Object.entries(admin)) assert.throws(() => loadServiceConfig({ ...env, [key]: value }));
  assert.throws(() => loadServiceConfig({ ...env, MOCHI_ADMIN_OID: '' }));
  assert.throws(() => loadServiceConfig({ ...env, ...admin, MOCHI_ADMIN_ORIGIN: 'http://remote.example.com' }));
  assert.throws(() => loadServiceConfig({ ...env, ...admin, MOCHI_AUTH_MODE: undefined }));
  assert.throws(() => loadServiceConfig({ ...env, MOCHI_AUTH_DIR: 'relative' }));
  assert.throws(() => loadServiceConfig({ ...env, MOCHI_DATA_DIR: '/tmp/mochi-auth/data' }));
  assert.throws(() => loadServiceConfig({ ...env, MOCHI_DATA_DIR: '/tmp' }));
});
