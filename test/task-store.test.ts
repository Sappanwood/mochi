import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../src/task-store.ts';

test('single data owner rejects overlap and static symlink roots/ancestors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const actual = join(root, 'actual'); await mkdir(actual); const link = join(root, 'link'); await symlink(actual, link);
  await assert.rejects(TaskStore.open(link), /unsafe_path/);
  const first = await TaskStore.open(actual); t.after(() => first.close());
  await assert.rejects(TaskStore.open(actual), /EEXIST/);
  await first.close(); const second = await TaskStore.open(actual); await second.close();
});
test('data owner loss prevents future mutations without overwriting successor owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = await TaskStore.open(root); t.after(() => store.close());
  await writeFile(join(root, '.owner', 'id'), 'successor');
  await assert.rejects(store.assertOwner(), /ownership_lost/); assert.equal(store.signal.aborted, true); await store.close();
});
test('corrupted session state and static app directory symlinks fail startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(tmpdir(), join(root, 'app'));
  await assert.rejects(TaskStore.open(root), /unsafe_path/);
  await rm(join(root, 'app')); await mkdir(join(root, 'app')); await mkdir(join(root, 'app', 'd3474fa3-68e7-4e45-9704-a3fa82f885c2'));
  await writeFile(join(root, 'app', 'd3474fa3-68e7-4e45-9704-a3fa82f885c2', 'session.json'), '{}');
  await assert.rejects(TaskStore.open(root), /invalid_data/);
});
