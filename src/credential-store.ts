import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthOperationOptions, Credential, CredentialStore } from '@earendil-works/pi-ai';

async function directory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('unsafe_path');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_path');
  }
}

async function readRegular(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe_path');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await file.readFile('utf8'); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function decode(content: string | undefined): Record<string, Credential> {
  try {
    const value: unknown = JSON.parse(content ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    for (const [provider, credential] of Object.entries(value)) {
      if (provider !== 'deepseek' && provider !== 'openai-codex') throw new Error();
      if (!credential || typeof credential !== 'object' || Array.isArray(credential)) throw new Error();
      if (provider === 'deepseek') {
        if (credential.type !== 'api_key' || typeof credential.key !== 'string'
          || !credential.key.trim() || credential.key.startsWith('!') || /[\r\n]/.test(credential.key)) throw new Error();
      } else if (credential.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access
        || typeof credential.refresh !== 'string' || !credential.refresh || !Number.isFinite(credential.expires)) throw new Error();
    }
    return value as Record<string, Credential>;
  } catch { throw new Error('invalid_credentials'); }
}

export class FileCredentials implements CredentialStore {
  readonly #root: string;
  readonly #id = randomUUID();
  readonly #controller = new AbortController();
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  get signal() { return this.#controller.signal; }

  private constructor(root: string) { this.#root = root; }

  static async open(root: string) {
    await directory(root);
    const store = new FileCredentials(root);
    const owner = join(root, '.owner');
    try { await mkdir(owner, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('ownership_busy');
      throw error;
    }
    try {
      const idFile = await open(join(owner, 'id'), 'wx', 0o600);
      try { await idFile.writeFile(store.#id); await idFile.sync(); } finally { await idFile.close(); }
      await store.#read();
      store.#timer = setInterval(() => { void store.#assertOwner().catch(() => {}); }, 1000);
      store.#timer.unref();
      return store;
    } catch (error) {
      await unlink(join(owner, 'id')).catch(() => {});
      await rmdir(owner).catch(() => {});
      throw error;
    }
  }

  async #assertOwner() {
    if (this.signal.aborted) throw new Error('ownership_lost');
    try {
      await directory(this.#root);
      await directory(join(this.#root, '.owner'));
      if (await readRegular(join(this.#root, '.owner', 'id')) !== this.#id) throw new Error();
    } catch {
      this.#controller.abort();
      if (this.#timer) clearInterval(this.#timer);
      throw new Error('ownership_lost');
    }
  }

  async #read() {
    await this.#assertOwner();
    try { return decode(await readRegular(join(this.#root, 'auth.json'))); }
    catch (error) {
      this.#controller.abort();
      if (this.#timer) clearInterval(this.#timer);
      throw error;
    }
  }

  #serialize<T>(fn: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    if (this.#closing || this.signal.aborted) return Promise.reject(new Error('ownership_lost'));
    const next = this.#tail.then(async () => {
      options?.signal?.throwIfAborted();
      await this.#assertOwner();
      return fn();
    });
    this.#tail = next.catch(() => {});
    return next;
  }

  async #write(data: Record<string, Credential>, options?: AuthOperationOptions) {
    const content = JSON.stringify(data);
    decode(content);
    const temp = join(this.#root, `.auth-${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temp, 'wx', 0o600);
      await file.writeFile(`${content}\n`); await file.sync(); await file.close();
      options?.signal?.throwIfAborted();
      await this.#assertOwner();
      await readRegular(join(this.#root, 'auth.json'));
      await rename(temp, join(this.#root, 'auth.json'));
      const dir = await open(this.#root, constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      if (!options?.signal?.aborted) {
        this.#controller.abort();
        if (this.#timer) clearInterval(this.#timer);
      }
      throw error;
    } finally {
      await file?.close().catch(() => {});
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async read(provider: string, options?: AuthOperationOptions) {
    if (this.#closing) throw new Error('ownership_lost');
    options?.signal?.throwIfAborted();
    return (await this.#read())[provider];
  }

  async list(options?: AuthOperationOptions) {
    if (this.#closing) throw new Error('ownership_lost');
    options?.signal?.throwIfAborted();
    return Object.entries(await this.#read()).map(([providerId, credential]) => ({
      providerId, type: credential.type,
    }));
  }

  modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    return this.#serialize(async () => {
      const data = await this.#read();
      const next = await fn(data[provider]);
      options?.signal?.throwIfAborted();
      await this.#assertOwner();
      if (next !== undefined) {
        data[provider] = next;
        await this.#write(data, options);
      }
      return data[provider];
    }, options);
  }

  delete(provider: string, options?: AuthOperationOptions) {
    return this.#serialize(async () => {
      const data = await this.#read();
      delete data[provider];
      await this.#write(data, options);
    }, options);
  }

  async release() {
    this.#closing = true;
    await this.#tail;
    await this.#assertOwner();
    if (this.#timer) clearInterval(this.#timer);
    await unlink(join(this.#root, '.owner', 'id'));
    await rmdir(join(this.#root, '.owner'));
    this.#controller.abort();
  }
}
