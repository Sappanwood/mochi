import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdminControl } from '../src/admin-control.ts';
import type { Pi } from '../src/pi.ts';

test('provider transactions bind to one admin session, expire and cancel without late success', async () => {
  let now = 1000;
  let saved = false;
  const pi = {
    async login(_provider, interaction) {
      assert.equal(await interaction.prompt({ type: 'select', message: 'method', options: [{ id: 'device_code', label: 'Device' }] }), 'device_code');
      interaction.notify({ type: 'device_code', userCode: 'ABCD', verificationUri: 'https://auth.openai.com/codex/device' });
      await new Promise<void>((_resolve, reject) => interaction.signal!.addEventListener('abort', () => reject(new Error('token-secret')), { once: true }));
      saved = true;
    },
    refreshOpenAI: async () => {}, status: async () => [], models: () => [], logout: async () => {},
  } as Pick<Pi, 'login' | 'status' | 'models' | 'logout' | 'refreshOpenAI'>;
  const control = new AdminControl(pi, new AbortController().signal, () => now);
  const identity = { oid: 'person', expires: 1000000 };
  const a = control.createSession(identity); const b = control.createSession(identity);
  const txn = control.startOpenAI(a.id);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(control.transaction(a.id, txn.id).state, 'authorizing');
  assert.throws(() => control.transaction(b.id, txn.id), /forbidden/);
  assert.throws(() => control.startOpenAI(b.id), /provider_busy/);
  control.cancel(a.id, txn.id);
  await control.close();
  assert.equal(saved, false);
  assert.equal(control.transaction(a.id, txn.id).state, 'cancelled');
  now = a.expires + 1;
  assert.throws(() => control.authorize(a.id, identity), /unauthorized/);
});

test('key save never echoes credentials and stale or foreign sessions cannot mutate', async () => {
  let calls = 0;
  const pi = {
    async login(_provider, interaction) { calls++; assert.equal(await interaction.prompt({ type: 'secret', message: 'key' }), 'secret-key'); },
    refreshOpenAI: async () => {}, status: async () => [{ provider: 'deepseek', auth: 'api_key', configured: true }], models: () => [], logout: async () => {},
  } as Pick<Pi, 'login' | 'status' | 'models' | 'logout' | 'refreshOpenAI'>;
  const control = new AdminControl(pi, new AbortController().signal);
  const person = { oid: 'person', expires: Date.now() + 600000 };
  const session = control.createSession(person);
  assert.throws(() => control.authorize(session.id, { ...person, oid: 'other' }), /unauthorized/);
  await control.saveKey(session.id, 'secret-key');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(await control.providers(session.id)).includes('secret-key'));
  control.endSession(session.id);
  await assert.rejects(() => control.saveKey(session.id, 'secret-key'));
  await control.close();
});

test('session logout aborts an in-flight key operation', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | undefined;
  const pi = {
    async login(_provider, interaction) {
      signal = interaction.signal; entered();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    },
    refreshOpenAI: async () => {}, status: async () => [], models: () => [], logout: async () => {},
  } as Pick<Pi, 'login' | 'status' | 'models' | 'logout' | 'refreshOpenAI'>;
  const control = new AdminControl(pi, new AbortController().signal);
  const session = control.createSession({ oid: 'person', expires: Date.now() + 100000 });
  const operation = control.saveKey(session.id, 'key');
  const rejected = assert.rejects(operation);
  await started; control.endSession(session.id); await rejected;
  assert.equal(signal?.aborted, true); await control.close();
});

test('subscription refresh excludes other mutations and session logout cancels it', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const control = new AdminControl({
    login: async () => {}, logout: async () => {}, models: () => [], status: async () => [],
    refreshOpenAI: async signal => {
      entered();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('authentication_required')), { once: true }));
    },
  }, new AbortController().signal);
  const session = control.createSession({ oid: 'person', expires: Date.now() + 100000 });
  const operation = control.refreshOpenAI(session.id);
  const rejected = assert.rejects(operation, /authentication_required/);
  await started;
  await assert.rejects(control.refreshOpenAI(session.id), /provider_busy/);
  await assert.rejects(control.saveKey(session.id, 'key'), /provider_busy/);
  await assert.rejects(control.logout(session.id, 'openai-codex'), /provider_busy/);
  assert.throws(() => control.startOpenAI(session.id), /provider_busy/);
  control.endSession(session.id); await rejected;
  await assert.rejects(control.refreshOpenAI(session.id), /unauthorized/);
  await control.close();
});
