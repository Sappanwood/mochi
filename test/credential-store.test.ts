import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileCredentials } from '../src/credential-store.ts';

test('credentials survive release and restart; metadata contains no secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-auth-'));
  const first = await FileCredentials.open(root);
  await first.modify('deepseek', async () => ({ type: 'api_key', key: 'private-key' }));
  assert.deepEqual(await first.list(), [{ providerId: 'deepseek', type: 'api_key' }]);
  const oauth = { type: 'oauth' as const, access: 'private-access', refresh: 'private-refresh', expires: 123, accountId: 'account' };
  await first.modify('openai-codex', async () => oauth);
  await first.release();
  await assert.rejects(() => first.read('deepseek'), /ownership_lost/);
  const next = await FileCredentials.open(root);
  t.after(async () => { await next.release(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await next.read('deepseek'), { type: 'api_key', key: 'private-key' });
  assert.deepEqual(await next.read('openai-codex'), oauth);
  await next.delete('deepseek');
  assert.equal(await next.read('deepseek'), undefined);
});

test('ownership excludes another process and persisted data is readable after handoff', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-auth-process-'));
  const store = await FileCredentials.open(root);
  t.after(async () => { await store.release().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await store.modify('deepseek', async () => ({ type: 'api_key', key: 'process-fixture' }));
  const run = promisify(execFile);
  const source = `import {FileCredentials} from './src/credential-store.ts';
    try { const s=await FileCredentials.open(process.argv[1]);
      const value=await s.read('deepseek'); await s.release(); console.log(value?.key==='process-fixture'?'restored':'wrong'); }
    catch(e){ console.log(e.message); }`;
  const child = () => run(process.execPath, ['--input-type=module', '-e', source, root], { cwd: process.cwd() });
  assert.equal((await child()).stdout.trim(), 'ownership_busy');
  await store.release();
  assert.equal((await child()).stdout.trim(), 'restored');
});

test('competing owners are rejected; mutations and release wait for the whole callback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-auth-'));
  const store = await FileCredentials.open(root);
  await assert.rejects(() => FileCredentials.open(root), /ownership_busy/);
  let unblock!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const mutation = store.modify('deepseek', async () => {
    started(); await barrier; return { type: 'api_key', key: 'rotated' };
  });
  await entered;
  let released = false;
  const release = store.release().then(() => { released = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(released, false);
  await assert.rejects(() => store.read('deepseek'), /ownership_lost/);
  unblock(); await mutation; await release;
  const next = await FileCredentials.open(root);
  t.after(async () => { await next.release(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await next.read('deepseek') as { key: string }).key, 'rotated');
});

test('failed and aborted updates preserve previous credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-auth-'));
  const store = await FileCredentials.open(root);
  t.after(async () => { await store.release(); await rm(root, { recursive: true, force: true }); });
  await store.modify('deepseek', async () => ({ type: 'api_key', key: 'old' }));
  await assert.rejects(() => store.modify('deepseek', async () => { throw new Error('refresh failed'); }));
  const controller = new AbortController();
  await assert.rejects(() => store.modify('deepseek', async () => {
    controller.abort(); return { type: 'api_key', key: 'new' };
  }, { signal: controller.signal }));
  assert.deepEqual(await store.read('deepseek'), { type: 'api_key', key: 'old' });
});

test('filesystem write failure preserves the old file and revokes service readiness', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-auth-readonly-'));
  const store = await FileCredentials.open(root);
  t.after(async () => { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); });
  await store.modify('deepseek', async () => ({ type: 'api_key', key: 'old' }));
  const original = await readFile(join(root, 'auth.json'), 'utf8');
  await chmod(root, 0o500);
  await assert.rejects(() => store.modify('deepseek', async () => ({ type: 'api_key', key: 'new' })));
  assert.equal(await readFile(join(root, 'auth.json'), 'utf8'), original);
  assert.equal(store.signal.aborted, true);
  await assert.rejects(() => store.read('deepseek'), /ownership_lost/);
});

test('rejects symlink ancestors, auth files and existing crash locks without replacing them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'real'));
  await symlink(join(root, 'real'), join(root, 'linked'));
  await assert.rejects(() => FileCredentials.open(join(root, 'linked')), /unsafe_path/);
  await writeFile(join(root, 'outside.json'), '{}');
  await symlink(join(root, 'outside.json'), join(root, 'real', 'auth.json'));
  await assert.rejects(() => FileCredentials.open(join(root, 'real')), /unsafe_path/);
  assert.equal(await readFile(join(root, 'outside.json'), 'utf8'), '{}');
  await mkdir(join(root, 'crashed'));
  await mkdir(join(root, 'crashed', '.owner'));
  await assert.rejects(() => FileCredentials.open(join(root, 'crashed')), /ownership_busy/);
});

test('corrupt stores fail closed; revoked ownership aborts work and prevents a late write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'auth.json'), '{broken');
  await assert.rejects(() => FileCredentials.open(root), /invalid_credentials/);
  await writeFile(join(root, 'auth.json'), '{}');
  const store = await FileCredentials.open(root);
  await assert.rejects(() => store.modify('deepseek', async () => {
    await writeFile(join(root, '.owner', 'id'), 'replacement');
    return { type: 'api_key', key: 'late-secret' };
  }), /ownership_lost/);
  assert.equal(store.signal.aborted, true);
  assert.equal(await readFile(join(root, 'auth.json'), 'utf8'), '{}');
  await assert.rejects(() => store.release(), /ownership_lost/);
  assert.equal(await readFile(join(root, '.owner', 'id'), 'utf8'), 'replacement');
});
