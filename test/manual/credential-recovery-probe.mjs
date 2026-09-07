import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, mkdir, rmdir, unlink, readdir } from 'node:fs/promises';
import { FileCredentials } from '../../dist/credential-store.js';
import { createPi } from '../../dist/pi.js';

// Only synthetic credentials inside a newly created directory on the selected mount.
const mount = process.env.MOCHI_AUTH_DIR;
if (!mount) throw new Error('MOCHI_AUTH_DIR is required');
const root = await mkdtemp(`${mount}/.mochi-recovery-`);
let store;
try {
  store = await FileCredentials.open(root);
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'fixture', refresh: 'fixture', expires: 1 }));
  const pi = await createPi(store);
  const oauth = pi.runtime.getProvider('openai-codex').auth.oauth;
  let refreshes = 0;
  oauth.refresh = async () => {
    refreshes++;
    await assert.rejects(FileCredentials.open(root), /ownership_busy/);
    return { type: 'oauth', access: 'rotated-fixture', refresh: 'rotated-fixture', expires: Date.now() + 3600000 };
  };
  oauth.toAuth = async credential => ({ apiKey: credential.access });
  const results = await Promise.all(Array.from({ length: 8 }, () => pi.runtime.getAuth('openai-codex')));
  assert.equal(refreshes, 1);
  assert.ok(results.every(result => result.auth.apiKey === 'rotated-fixture'));
  await store.release();
  store = await FileCredentials.open(root);
  assert.equal((await store.read('openai-codex')).refresh, 'rotated-fixture');
  console.log('PASS: concurrent Pi refresh, SMB writeback and owner handoff');

  await store.modify('openai-codex', async current => ({ ...current, expires: 1 }));
  const failing = await createPi(store);
  let failures = 0;
  failing.runtime.getProvider('openai-codex').auth.oauth.refresh = async () => {
    failures++;
    throw new Error('synthetic lost response');
  };
  const rejected = await Promise.allSettled(Array.from({ length: 8 }, () => failing.runtime.getAuth('openai-codex')));
  assert.ok(rejected.every(result => result.status === 'rejected'));
  assert.equal(failures, 1);
  await store.release();
  store = await FileCredentials.open(root);
  const restarted = await createPi(store);
  await assert.rejects(restarted.runtime.getAuth('openai-codex'));
  assert.equal((await restarted.status())[1].configured, false);
  await restarted.logout('openai-codex');
  assert.deepEqual(await store.list(), []);
  console.log('PASS: uncertain refresh quarantined across reopen, logout clears state');

  await store.modify('deepseek', async () => ({ type: 'api_key', key: 'recovery-fixture' }));
  const original = await readFile(`${root}/auth.json`, 'utf8');
  await assert.rejects(store.modify('deepseek', async () => {
    await rename(`${root}/auth.json`, `${root}/saved.json`);
    await mkdir(`${root}/auth.json`);
    return { type: 'api_key', key: 'must-not-persist' };
  }), /unsafe_path/);
  assert.equal(store.signal.aborted, true);
  assert.equal(await readFile(`${root}/saved.json`, 'utf8'), original);
  await assert.rejects(FileCredentials.open(root), /ownership_busy/);
  // All operations are settled; this isolated owner is failed and cannot write again.
  await rmdir(`${root}/auth.json`);
  await rename(`${root}/saved.json`, `${root}/auth.json`);
  await unlink(`${root}/.owner/id`);
  await rmdir(`${root}/.owner`);
  store = await FileCredentials.open(root);
  assert.equal((await store.read('deepseek')).key, 'recovery-fixture');
  await store.delete('deepseek');
  await store.release(); store = undefined;
  assert.deepEqual(await readdir(root), ['auth.json']);
  console.log('PASS: pre-publication storage fault fails closed, isolated recovery and reacquisition');
} finally {
  if (store && !store.signal.aborted) await store.release();
  // Keep unexpected remnants for diagnosis; never recursively delete the mount.
  await unlink(`${root}/auth.json`);
  await rmdir(root);
}
