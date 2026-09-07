import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryCredentialStore, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createPi } from '../src/pi.ts';
import { piExecutor } from '../src/executor.ts';
import type { ExecutionInput } from '../src/tasks.ts';

function fixture(model: string): ExecutionInput {
  const created_at = new Date().toISOString();
  return { run: { app_id: 'alpha', run_id: '9ef76b29-43bf-4743-a8ea-19b5947869bb', session_id: 'bb3e662a-0dc4-442c-8fb9-352e503bc034',
    status: 'running', created_at, updated_at: created_at, result: null, error: null, usage: null, dispatched: true, events: [],
    input: { idempotency_key: 'key', provider: 'deepseek', model, prompt: 'new-input', max_output_tokens: 123 } },
    session: { app_id: 'alpha', session_id: 'bb3e662a-0dc4-442c-8fb9-352e503bc034', created_at, system_prompt: 'stable-system' },
    history: [{ role: 'user', content: 'previous-user' }, { role: 'assistant', content: 'previous-assistant' }] };
}
test('real Pi executor restores history and system prefix, enforces output limit and reports actual usage', async t => {
  const credentials = new InMemoryCredentialStore(); await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'fake' }));
  const pi = await createPi(credentials); const model = pi.models().find(m => m.provider === 'deepseek')!;
  let calls = 0;
  t.mock.method(pi.runtime, 'streamSimple', (...[model, context, options]: Parameters<typeof pi.runtime.streamSimple>) => {
    calls++; assert.equal(context.systemPrompt, 'stable-system'); assert.equal(options?.maxTokens, 123); assert.equal(options?.maxRetries, 0);
    assert.equal(options?.sessionId, 'bb3e662a-0dc4-442c-8fb9-352e503bc034');
    assert.deepEqual(context.tools ?? [], []); assert.ok(JSON.stringify(context.messages).includes('previous-assistant'));
    assert.ok(JSON.stringify(context.messages).includes('new-input'));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'complete' }], api: model.api, provider: model.provider,
      model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, totalTokens: 17,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'done', reason: 'stop', message }); return stream;
  });
  const output = await piExecutor(pi)(fixture(model.id), new AbortController().signal, async () => {});
  assert.equal(calls, 1); assert.equal(output.text, 'complete'); assert.deepEqual(output.usage, { input: 10, output: 2, cache_read: 4, cache_write: 1, total_tokens: 17 });
});
test('length-limited provider output never becomes an adoptable result', async t => {
  const credentials = new InMemoryCredentialStore(); await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'fake' }));
  const pi = await createPi(credentials); const model = pi.models().find(m => m.provider === 'deepseek')!;
  t.mock.method(pi.runtime, 'streamSimple', (...[model]: Parameters<typeof pi.runtime.streamSimple>) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'partial' }], api: model.api, provider: model.provider,
      model: model.id, stopReason: 'length', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'done', reason: 'length', message }); return stream;
  });
  await assert.rejects(piExecutor(pi)(fixture(model.id), new AbortController().signal, async () => {}), /incomplete_output/);
});
