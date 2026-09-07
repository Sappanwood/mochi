import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink, lstat } from 'node:fs/promises';
import { FileCredentials } from '../../dist/credential-store.js';

// Run only against an explicitly selected mount; never modify the active credential file.
const mount = process.env.MOCHI_AUTH_DIR;
if (!mount) throw new Error('MOCHI_AUTH_DIR is required');
const root = await mkdtemp(`${mount}/.mochi-probe-`);
let owner;
try {
  owner = await FileCredentials.open(root);
  await assert.rejects(FileCredentials.open(root), /ownership_busy/);
  await owner.modify('deepseek', async () => ({ type: 'api_key', key: 'non-secret-storage-probe' }));
  assert.equal((await lstat(`${root}/auth.json`)).mode & 0o777, 0o600);
  await owner.release(); owner = undefined;
  owner = await FileCredentials.open(root);
  assert.equal((await owner.read('deepseek')).key, 'non-secret-storage-probe');
  await owner.modify('deepseek', async () => ({ type: 'api_key', key: 'non-secret-replaced-probe' }));
  assert.equal((await owner.read('deepseek')).key, 'non-secret-replaced-probe');
  await owner.delete('deepseek');
  assert.deepEqual(await owner.list(), []);
  console.log('credential mount probe: write, fsync, rename, exclusion, reopen and delete passed');
} finally {
  await owner?.release();
  await unlink(`${root}/auth.json`).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(root);
}
