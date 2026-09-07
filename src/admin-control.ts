import { randomBytes } from 'node:crypto';
import type { Pi } from './pi.ts';
import type { AdminIdentity } from './admin-auth.ts';
import { AccessError } from './auth.ts';

interface Transaction {
  id: string; session: string; expires: number;
  state: 'authorizing' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  userCode?: string; verificationUri?: string;
  controller: AbortController; done: Promise<void>;
}

export class AdminControl {
  readonly #pi: Pick<Pi, 'login' | 'logout' | 'models' | 'status' | 'refreshOpenAI'>;
  readonly #ownership: AbortSignal;
  readonly #now: () => number;
  readonly #sessions = new Map<string, AdminIdentity & { controller: AbortController }>();
  readonly #transactions = new Map<string, Transaction>();
  readonly #timer: ReturnType<typeof setInterval>;
  #active: Transaction | undefined;
  #keyBusy = false;
  constructor(pi: Pick<Pi, 'login' | 'logout' | 'models' | 'status' | 'refreshOpenAI'>, ownership: AbortSignal, now = Date.now) {
    this.#pi = pi; this.#ownership = ownership; this.#now = now;
    this.#timer = setInterval(() => this.#expire(), 1000);
    this.#timer.unref();
  }
  #expire() {
    for (const [id, session] of this.#sessions) if (session.expires <= this.#now()) this.endSession(id);
    for (const [id, txn] of this.#transactions) {
      if (txn.expires <= this.#now() && txn.state === 'authorizing') {
        txn.state = 'expired'; txn.controller.abort();
      }
      if (txn.expires + 600000 <= this.#now()) this.#transactions.delete(id);
    }
  }
  createSession(identity: AdminIdentity) {
    this.#expire();
    if (this.#ownership.aborted || identity.expires <= this.#now()) throw new AccessError(401);
    if (this.#sessions.size >= 16) throw new Error('session_limit');
    const id = randomBytes(32).toString('base64url');
    const expires = Math.min(identity.expires, this.#now() + 600000);
    this.#sessions.set(id, { ...identity, expires, controller: new AbortController() });
    return { id, expires };
  }
  authorize(id: string, identity?: AdminIdentity) {
    const session = this.#sessions.get(id);
    if (!session || session.expires <= this.#now() || (identity && identity.oid !== session.oid)
      || this.#ownership.aborted) throw new AccessError(401);
  }
  endSession(id: string) {
    this.#sessions.get(id)?.controller.abort();
    this.#sessions.delete(id);
    for (const txn of this.#transactions.values()) if (txn.session === id && txn.state === 'authorizing') {
      txn.state = 'cancelled'; txn.controller.abort();
    }
  }
  async providers(session: string) {
    this.authorize(session);
    return { providers: await this.#pi.status(), models: this.#pi.models() };
  }
  async saveKey(session: string, key: string) {
    this.authorize(session);
    if (this.#active || this.#keyBusy) throw new Error('provider_busy');
    if (!key || key.length > 8192) throw new Error('invalid_key');
    this.#keyBusy = true;
    try {
      await this.#pi.login('deepseek', { signal: AbortSignal.any([this.#ownership, this.#sessions.get(session)!.controller.signal]),
        prompt: async prompt => {
          this.authorize(session);
          if (prompt.type !== 'secret') throw new Error('unexpected_prompt');
          return key;
        }, notify: () => {},
      });
    } finally { this.#keyBusy = false; }
  }
  async refreshOpenAI(session: string) {
    this.authorize(session);
    if (this.#active || this.#keyBusy) throw new Error('provider_busy');
    this.#keyBusy = true;
    try {
      await this.#pi.refreshOpenAI(AbortSignal.any([this.#ownership, this.#sessions.get(session)!.controller.signal]));
    } finally { this.#keyBusy = false; }
  }
  startOpenAI(session: string) {
    this.authorize(session);
    if (this.#active || this.#keyBusy) throw new Error('provider_busy');
    const txn: Transaction = {
      id: randomBytes(24).toString('base64url'), session,
      expires: Math.min(this.#sessions.get(session)!.expires, this.#now() + 300000),
      state: 'authorizing', controller: new AbortController(), done: Promise.resolve(),
    };
    this.#transactions.set(txn.id, txn); this.#active = txn;
    txn.done = this.#pi.login('openai-codex', {
      signal: AbortSignal.any([txn.controller.signal, this.#ownership]),
      prompt: async prompt => {
        if (prompt.type === 'select' && prompt.options.some(option => option.id === 'device_code')) return 'device_code';
        throw new Error('headless_login_unavailable');
      },
      notify: event => {
        if (txn.state !== 'authorizing') return;
        if (event.type === 'device_code') {
          if (event.verificationUri !== 'https://auth.openai.com/codex/device') throw new Error('unexpected_login_url');
          txn.userCode = event.userCode; txn.verificationUri = event.verificationUri;
        }
      },
    }).then(() => { if (txn.state === 'authorizing') txn.state = 'succeeded'; })
      .catch(() => { if (txn.state === 'authorizing') txn.state = 'failed'; })
      .finally(() => { this.#active = undefined; });
    return this.transaction(session, txn.id);
  }
  transaction(session: string, id: string) {
    this.authorize(session);
    const txn = this.#transactions.get(id);
    if (!txn || txn.session !== session) throw new AccessError(403);
    if (txn.expires <= this.#now() && txn.state === 'authorizing') { txn.state = 'expired'; txn.controller.abort(); }
    return { id, state: txn.state, expires: txn.expires,
      ...(txn.state === 'authorizing' ? { userCode: txn.userCode, verificationUri: txn.verificationUri } : {}),
    };
  }
  cancel(session: string, id: string) {
    this.transaction(session, id);
    const txn = this.#transactions.get(id)!;
    if (txn.state === 'authorizing') { txn.state = 'cancelled'; txn.controller.abort(); }
  }
  async logout(session: string, provider: string) {
    this.authorize(session);
    if (this.#active || this.#keyBusy) throw new Error('provider_busy');
    await this.#pi.logout(provider);
  }
  async close() {
    clearInterval(this.#timer);
    for (const session of this.#sessions.values()) session.controller.abort();
    if (this.#active) {
      this.#active.state = 'cancelled'; this.#active.controller.abort();
      await this.#active.done;
    }
  }
}
