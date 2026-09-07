import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryCredentialStore, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage, OAuthCredential } from '@earendil-works/pi-ai';
import { FileCredentials } from '../src/credential-store.ts';
import { createPi, openConversation } from '../src/pi.ts';

test('only DeepSeek API and OpenAI subscription are exposed without network or credentials', async () => {
  const pi = await createPi(new InMemoryCredentialStore());
  const models = pi.models();
  assert.ok(models.some(m => m.provider === 'deepseek'));
  assert.ok(models.some(m => m.provider === 'openai-codex'));
  assert.ok(models.every(m => ['deepseek', 'openai-codex'].includes(m.provider)));
  assert.ok(models.every(m => m.auth === (m.provider === 'deepseek' ? 'api_key' : 'oauth')));
  assert.deepEqual(await pi.status(), [
    { provider: 'deepseek', auth: 'api_key', configured: false },
    { provider: 'openai-codex', auth: 'oauth', configured: false },
  ]);
});

test('DeepSeek login saves via CredentialStore and logout removes authentication', async () => {
  const credentials = new InMemoryCredentialStore();
  const pi = await createPi(credentials);
  await pi.login('deepseek', {
    prompt: async prompt => { assert.equal(prompt.type, 'secret'); return 'test-deepseek-key'; },
    notify: () => {},
  });
  assert.deepEqual(await credentials.read('deepseek'), { type: 'api_key', key: 'test-deepseek-key' });
  assert.equal((await pi.status())[0]!.configured, true);
  const auth = await pi.runtime.getAuth('deepseek');
  assert.equal(auth?.auth.apiKey, 'test-deepseek-key');
  await pi.logout('deepseek');
  assert.equal((await pi.status())[0]!.configured, false);
  await assert.rejects(() => pi.runtime.getAuth('deepseek'));
});

test('OpenAI login uses native subscription OAuth and exposes no credentials in its result', async (t) => {
  const credentials = new InMemoryCredentialStore();
  const pi = await createPi(credentials);
  const provider = pi.runtime.getProvider('openai-codex')!;
  assert.equal(provider.auth.oauth?.isSubscription, true);
  assert.equal(provider.auth.apiKey, undefined);
  const login = t.mock.method(provider.auth.oauth!, 'login', async () => ({
    type: 'oauth' as const, access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000,
  }));
  const result = await pi.login('openai-codex', { prompt: async () => '', notify: () => {} });
  assert.equal(login.mock.callCount(), 1);
  assert.equal(result, undefined);
  assert.equal((await credentials.read('openai-codex'))?.type, 'oauth');
  assert.ok(!JSON.stringify(await pi.status()).includes('test-access'));
  await pi.logout('openai-codex');
  assert.equal(await credentials.read('openai-codex'), undefined);
});

test('Pi refresh serializes through the shared store and writes back rotated OAuth credentials', async (t) => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('openai-codex', async () => ({
    type: 'oauth', access: 'expired-access', refresh: 'old-refresh', expires: 1,
  }));
  const instances = [await createPi(credentials), await createPi(credentials)];
  let refreshes = 0;
  for (const pi of instances) {
    const oauth = pi.runtime.getProvider('openai-codex')!.auth.oauth!;
    t.mock.method(oauth, 'refresh', async () => {
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { type: 'oauth', access: 'rotated-access', refresh: 'rotated-refresh', expires: Date.now() + 3600000 };
    });
    t.mock.method(oauth, 'toAuth', async (credential: OAuthCredential) => ({ apiKey: credential.access }));
  }
  const results = await Promise.all(instances.map(pi => pi.runtime.getAuth('openai-codex')));
  assert.equal(refreshes, 1);
  assert.ok(results.every(result => result?.auth.apiKey === 'rotated-access'));
  assert.equal((await credentials.read('openai-codex'))?.type, 'oauth');
  assert.equal((await credentials.read('openai-codex') as { refresh: string }).refresh, 'rotated-refresh');
});

test('failed refresh preserves stored credentials and reports failure without retry', async (t) => {
  const credentials = new InMemoryCredentialStore();
  const expired = { type: 'oauth' as const, access: 'expired', refresh: 'revoked', expires: 1 };
  await credentials.modify('openai-codex', async () => expired);
  const pi = await createPi(credentials);
  const refresh = t.mock.method(pi.runtime.getProvider('openai-codex')!.auth.oauth!, 'refresh', async () => {
    throw new Error('invalid_grant');
  });
  await assert.rejects(() => pi.runtime.getAuth('openai-codex'));
  assert.equal(refresh.mock.callCount(), 1);
  assert.deepEqual(await credentials.read('openai-codex'), { ...expired, mochiReauthenticationRequired: true });
});

test('login rejects unsafe keys, unsupported providers, cancellation and failed persistence', async () => {
  const credentials = new InMemoryCredentialStore();
  const pi = await createPi(credentials);
  const interaction = { prompt: async () => '!unsafe-command', notify: () => {} };
  await assert.rejects(() => pi.login('deepseek', interaction), /invalid_credential/);
  assert.equal(await credentials.read('deepseek'), undefined);
  await assert.rejects(() => pi.login('openai', interaction), /unsupported_provider/);
  await assert.rejects(() => pi.login('deepseek', {
    prompt: async () => { throw new Error('cancelled'); }, notify: () => {},
  }));
  const failedStore = {
    read: async () => undefined, list: async () => [], delete: async () => {},
    modify: async () => { throw new Error('disk failure'); },
  };
  const broken = await createPi(failedStore);
  await assert.rejects(() => broken.login('deepseek', { prompt: async () => 'test-key', notify: () => {} }), /credential_operation_failed/);
  assert.equal((await broken.status())[0]!.configured, false);
});

test('missing or wrong credential modes cannot fall back to ambient keys', async (t) => {
  const store = new InMemoryCredentialStore();
  const pi = await createPi(store);
  t.mock.method(pi.runtime, 'hasConfiguredAuth', () => true);
  await assert.rejects(() => pi.requireModel('deepseek', pi.models().find(m => m.provider === 'deepseek')!.id), /authentication_required/);
  await store.modify('openai-codex', async () => ({ type: 'api_key', key: 'must-not-fallback' }));
  await assert.rejects(() => pi.requireModel('openai-codex', 'gpt-5.4'), /authentication_required/);
  await store.modify('deepseek', async () => ({ type: 'api_key', key: '!touch /tmp/never-execute' }));
  await assert.rejects(() => pi.requireModel('deepseek', pi.models().find(m => m.provider === 'deepseek')!.id), /authentication_required/);
  await assert.rejects(() => pi.requireModel('openai', 'anything'), /unsupported_model/);
  await assert.rejects(() => pi.requireModel('deepseek', 'nonexistent-model'), /unsupported_model/);
});

test('real Pi sessions have no tools, local resources or cross-session history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-pi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'work');
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(join(cwd, 'AGENTS.md'), 'PRIVATE-LOCAL-CONTEXT');
  await writeFile(join(agentDir, 'SYSTEM.md'), 'PRIVATE-SYSTEM-PROMPT');
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'fake-key' }));
  const pi = await createPi(credentials);
  const modelId = pi.models().find(m => m.provider === 'deepseek')!.id;
  const contexts: string[] = [];
  t.mock.method(pi.runtime, 'streamSimple', (...[model, context]: Parameters<typeof pi.runtime.streamSimple>) => {
    contexts.push(JSON.stringify(context));
    assert.deepEqual(context.tools ?? [], []);
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: 'mock reply' }], api: model.api,
      provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  });
  const a = await openConversation(pi, { cwd, agentDir, provider: 'deepseek', model: modelId });
  const b = await openConversation(pi, { cwd, agentDir, provider: 'deepseek', model: modelId });
  t.after(() => { a.dispose(); b.dispose(); });
  assert.deepEqual(a.getActiveToolNames(), []);
  assert.deepEqual(b.getActiveToolNames(), []);
  await a.prompt('alpha-private', { expandPromptTemplates: false });
  await b.prompt('beta-private', { expandPromptTemplates: false });
  assert.ok(contexts[0]!.includes('alpha-private'));
  assert.ok(!contexts[1]!.includes('alpha-private'));
  assert.ok(contexts.every(c => !c.includes('PRIVATE-LOCAL-CONTEXT') && !c.includes('PRIVATE-SYSTEM-PROMPT')));
  assert.ok(!JSON.stringify(await pi.status()).includes('fake-key'));
});


test('uncertain refresh blocks queued requests and survives restart until login', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-refresh-'));
  let store = await FileCredentials.open(root);
  t.after(async () => { if (!store.signal.aborted) await store.release(); await rm(root, { recursive: true, force: true }); });
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'old', refresh: 'old', expires: 1 }));
  const pi = await createPi(store);
  const oauth = pi.runtime.getProvider('openai-codex')!.auth.oauth!;
  const refresh = t.mock.method(oauth, 'refresh', async () => { throw new Error('response lost'); });
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => pi.runtime.getAuth('openai-codex')));
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(refresh.mock.callCount(), 1);
  assert.equal((await pi.status())[1]!.configured, false);
  await store.release();
  store = await FileCredentials.open(root);
  const restarted = await createPi(store);
  await assert.rejects(() => restarted.runtime.getAuth('openai-codex'));
  assert.equal(refresh.mock.callCount(), 1);
  t.mock.method(restarted.runtime.getProvider('openai-codex')!.auth.oauth!, 'login', async () => ({
    type: 'oauth', access: 'new', refresh: 'new', expires: Date.now() + 3600000,
  }));
  await restarted.login('openai-codex', { prompt: async () => '', notify: () => {} });
  assert.equal((await restarted.status())[1]!.configured, true);
});

test('cancelled refresh persists uncertainty despite an aborted request signal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-refresh-cancel-'));
  const store = await FileCredentials.open(root);
  t.after(async () => { if (!store.signal.aborted) await store.release(); await rm(root, { recursive: true, force: true }); });
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'old', refresh: 'old', expires: 1 }));
  const pi = await createPi(store);
  const controller = new AbortController();
  t.mock.method(pi.runtime.getProvider('openai-codex')!.auth.oauth!, 'refresh', async () => {
    controller.abort();
    return { type: 'oauth', access: 'lost', refresh: 'lost', expires: Date.now() + 3600000 };
  });
  await assert.rejects(() => pi.runtime.getAuth('openai-codex', { signal: controller.signal }));
  // release drains the mutation even if Pi returns cancellation before persistence ends.
  await store.release();
  const next = await FileCredentials.open(root);
  const restored = await createPi(next);
  assert.equal((await restored.status())[1]!.configured, false);
  await assert.rejects(() => restored.runtime.getAuth('openai-codex'));
  await next.release();
});

test('explicit subscription refresh persists rotated credentials and quarantines failure', async (t) => {
  const store = new InMemoryCredentialStore();
  const original = { type: 'oauth' as const, access: 'old', refresh: 'old', expires: Date.now() + 3600000 };
  await store.modify('openai-codex', async () => original);
  const pi = await createPi(store);
  const oauth = pi.runtime.getProvider('openai-codex')!.auth.oauth!;
  const refresh = t.mock.method(oauth, 'refresh', async () => ({ ...original, access: 'new', refresh: 'new' }));
  assert.equal(await pi.refreshOpenAI(), undefined);
  assert.equal(refresh.mock.callCount(), 1);
  assert.equal((await store.read('openai-codex') as OAuthCredential).refresh, 'new');
  refresh.mock.mockImplementation(async () => { throw new Error('private-token-error'); });
  await assert.rejects(pi.refreshOpenAI(), /authentication_required/);
  await assert.rejects(pi.refreshOpenAI(), /authentication_required/);
  assert.equal(refresh.mock.callCount(), 2);
  assert.equal((await pi.status())[1]!.configured, false);
});

test('explicit refresh rejects an already expired replacement', async (t) => {
  const store = new InMemoryCredentialStore();
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'old', refresh: 'old', expires: 1 }));
  const pi = await createPi(store);
  t.mock.method(pi.runtime.getProvider('openai-codex')!.auth.oauth!, 'refresh', async () => ({
    type: 'oauth', access: 'expired', refresh: 'expired', expires: 1,
  }));
  await assert.rejects(pi.refreshOpenAI(), /authentication_required/);
  assert.equal((await pi.status())[1]!.configured, false);
});
