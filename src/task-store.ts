import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoredRun, StoredSession } from './task-types.ts';

async function directory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('unsafe_path');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_path');
  }
}
async function regular(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error('unsafe_file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return await file.readFile('utf8'); } finally { await file.close(); }
}
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const app = /^[a-z][a-z0-9_-]{0,63}$/;
export class TaskStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly runs = new Map<string, StoredRun>();
  readonly #owner = randomUUID();
  readonly #controller = new AbortController();
  #closed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  get signal() { return this.#controller.signal; }
  readonly root: string;
  private constructor(root: string) { this.root = root; }
  static async open(root: string) {
    await directory(root);
    const store = new TaskStore(root);
    await mkdir(join(root, '.owner'), { mode: 0o700 });
    try {
      const file = await open(join(root, '.owner', 'id'), 'wx', 0o600);
      try { await file.writeFile(store.#owner); await file.sync(); } finally { await file.close(); }
      await store.#load();
      store.#timer = setInterval(() => { void store.assertOwner().catch(() => {}); }, 1000);
      store.#timer.unref();
      return store;
    } catch (error) { await store.close(); throw error; }
  }
  async assertOwner() {
    if (this.signal.aborted || this.#closed) throw new Error('ownership_lost');
    try {
      await directory(join(this.root, '.owner'));
      if (await regular(join(this.root, '.owner', 'id')) !== this.#owner) throw new Error();
    } catch { this.#controller.abort(); throw new Error('ownership_lost'); }
  }
  async #load() {
    for (const appId of await readdir(this.root)) {
      if (appId.startsWith('.')) continue;
      if (!app.test(appId)) throw new Error('invalid_data');
      const appRoot = join(this.root, appId); await directory(appRoot);
      for (const sessionId of await readdir(appRoot)) {
        if (!id.test(sessionId)) throw new Error('invalid_data');
        const sessionRoot = join(appRoot, sessionId); await directory(sessionRoot);
        const session = JSON.parse(await regular(join(sessionRoot, 'session.json'))) as StoredSession;
        if (session.session_id !== sessionId || session.app_id !== appId || typeof session.system_prompt !== 'string'
          || !Number.isFinite(Date.parse(session.created_at))) throw new Error('invalid_data');
        this.sessions.set(sessionId, session);
        for (const name of await readdir(sessionRoot)) {
          if (name === 'session.json' || name.startsWith('.')) continue;
          if (!name.endsWith('.json') || !id.test(name.slice(0, -5))) throw new Error('invalid_data');
          const run = JSON.parse(await regular(join(sessionRoot, name))) as StoredRun;
          if (run.run_id !== name.slice(0, -5) || run.app_id !== appId || run.session_id !== sessionId
            || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)
            || !run.input || typeof run.input.prompt !== 'string' || typeof run.input.idempotency_key !== 'string'
            || !Array.isArray(run.events) || run.events.some((event, index) => event.cursor !== index + 1)
            || (run.status === 'succeeded' && typeof run.result?.text !== 'string')) throw new Error('invalid_data');
          this.runs.set(run.run_id, run);
        }
      }
    }
  }
  async #write(path: string, value: unknown) {
    await this.assertOwner(); await directory(dirname(path));
    try { await regular(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temp = join(dirname(path), `.write-${randomUUID()}`);
    let file;
    try {
      const data = JSON.stringify(value);
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error('data_limit');
      file = await open(temp, 'wx', 0o600); await file.writeFile(data); await file.sync(); await file.close();
      await this.assertOwner(); await rename(temp, path);
      const dir = await open(dirname(path), constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) { this.#controller.abort(); throw error; }
    finally { await file?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  }
  async saveSession(session: StoredSession) {
    if (!app.test(session.app_id) || !id.test(session.session_id)) throw new Error('unsafe_path');
    await this.assertOwner();
    const appRoot = join(this.root, session.app_id);
    await mkdir(appRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await directory(appRoot);
    const sessionRoot = join(appRoot, session.session_id);
    await mkdir(sessionRoot, { mode: 0o700 });
    await this.#write(join(sessionRoot, 'session.json'), session);
    this.sessions.set(session.session_id, structuredClone(session));
  }
  async saveRun(run: StoredRun) {
    if (!app.test(run.app_id) || !id.test(run.session_id) || !id.test(run.run_id)) throw new Error('unsafe_path');
    await this.#write(join(this.root, run.app_id, run.session_id, `${run.run_id}.json`), run);
    this.runs.set(run.run_id, structuredClone(run));
  }
  async close() {
    if (this.#closed) return;
    if (this.#timer) clearInterval(this.#timer);
    try {
      await directory(join(this.root, '.owner'));
      if (await regular(join(this.root, '.owner', 'id')) === this.#owner) {
        await unlink(join(this.root, '.owner', 'id')); await rmdir(join(this.root, '.owner'));
      }
    } finally { this.#closed = true; this.#controller.abort(); }
  }
}
