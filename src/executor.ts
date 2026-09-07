import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConversation } from './pi.ts';
import type { Pi } from './pi.ts';
import type { Execute } from './tasks.ts';
import type { Usage } from './task-types.ts';

export function piExecutor(pi: Pi): Execute {
  return async (input, signal, delta) => {
    const root = await mkdtemp(join(tmpdir(), `mochi-${input.run.app_id}-${input.run.session_id}-`));
    let session: Awaited<ReturnType<typeof openConversation>> | undefined;
    try {
      signal.throwIfAborted();
      const cwd = join(root, 'work'); const agentDir = join(root, 'agent');
      await mkdir(cwd); await mkdir(agentDir);
      session = await openConversation(pi, { cwd, agentDir, provider: input.run.input.provider, model: input.run.input.model,
        sessionId: input.session.session_id, systemPrompt: input.session.system_prompt, maxOutputTokens: input.run.input.max_output_tokens, history: input.history });
      const current = session;
      const abort = () => { void current.abort(); };
      signal.addEventListener('abort', abort, { once: true });
      let writes = Promise.resolve(); let writeError: unknown;
      const unsubscribe = session.subscribe(event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          const text = event.assistantMessageEvent.delta;
          writes = writes.then(() => delta(text)).catch(error => { writeError = error; abort(); });
        }
      });
      try {
        signal.throwIfAborted();
        await session.prompt(input.run.input.prompt, { expandPromptTemplates: false });
        await writes;
        if (writeError) throw writeError;
        signal.throwIfAborted();
        const last = session.messages.at(-1);
        if (!last || last.role !== 'assistant' || last.stopReason !== 'stop') throw new Error('incomplete_output');
        const text = last.content.filter(part => part.type === 'text').map(part => part.text).join('');
        const raw = last.usage;
        const usage: Usage | null = raw && [raw.input, raw.output, raw.cacheRead, raw.cacheWrite, raw.totalTokens].every(Number.isFinite) && raw.totalTokens > 0
          ? { input: raw.input, output: raw.output, cache_read: raw.cacheRead, cache_write: raw.cacheWrite, total_tokens: raw.totalTokens } : null;
        return { text, usage };
      } finally { unsubscribe(); signal.removeEventListener('abort', abort); }
    } finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
  };
}
