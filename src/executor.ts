import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConversation } from './pi.ts';
import type { Pi } from './pi.ts';
import type { Execute } from './tasks.ts';
import type { Usage } from './task-types.ts';
import { AppTools } from './app-tools.ts';
import { toolExecution } from './tool-execution.ts';

export function piExecutor(pi: Pi, appTools = new AppTools({}), open = (input: Parameters<typeof openConversation>[1]) => openConversation(pi, input)): Execute {
  type Conversation = Awaited<ReturnType<typeof openConversation>>;
  const cached = new Map<string, { session: Conversation; root: string; configuration: Parameters<typeof openConversation>[1];
    delegate?: ReturnType<typeof toolExecution> }>();
  const execute: Execute = async (input, signal, delta, record) => {
    const key = input.run.app_id + '/' + input.run.session_id;
    let entry = input.session.tool_protocol_version === 2 ? cached.get(key) : undefined;
    const root = entry?.root ?? await mkdtemp(join(tmpdir(), `mochi-${input.run.app_id}-${input.run.session_id}-`));
    let session: Awaited<ReturnType<typeof openConversation>> | undefined;
    let fatal: Error | undefined;
    const stop = (error: Error) => { fatal ??= error; void session?.abort(); };
    const tools = input.session.tools?.length ? (() => {
      if (!record || !input.run.input.scope || !input.run.input.budget) throw new Error('invalid_tool_execution');
      appTools.assertSupported(input.run.app_id, input.session.tools);
      return toolExecution(input, appTools, record, signal, stop);
    })() : undefined;
    try {
      signal.throwIfAborted();
      const cwd = join(root, 'work'); const agentDir = join(root, 'agent');
      if (!entry) { await mkdir(cwd); await mkdir(agentDir); }
      const configuration = entry?.configuration ?? { cwd, agentDir, provider: input.run.input.provider, model: input.run.input.model,
        sessionId: input.session.session_id, systemPrompt: input.session.system_prompt, maxOutputTokens: input.run.input.max_output_tokens,
        thinkingLevel: input.session.thinking_level,
        history: input.history, piHistory: input.piHistory, customTools: tools?.customTools };
      configuration.maxOutputTokens = input.run.input.max_output_tokens;
      if (entry) {
        entry.delegate = tools;
        session = entry.session;
        await session.setModel(await pi.requireModel(input.run.input.provider, input.run.input.model));
      } else {
        if (input.session.tool_protocol_version === 2 && tools) {
          configuration.customTools = tools.customTools.map((tool, i) => ({ ...tool, execute: (...args) => {
            if (!entry?.delegate) throw new Error('inactive_run');
            return entry.delegate.customTools[i]!.execute(...args);
          } }));
        }
        session = await open(configuration);
        if (input.session.tool_protocol_version === 2) { entry = { session, root, configuration, delegate: tools }; cached.set(key, entry); }
      }
      const current = session;
      const abort = () => { void current.abort(); };
      signal.addEventListener('abort', abort, { once: true });
      const baseStream = current.agent.streamFunction;
      if (tools) {
        const stream = current.agent.streamFunction;
        current.agent.streamFunction = async (model, context, options) => {
          if (fatal) throw fatal;
          await tools.beforeModel(context, model.contextWindow);
          return stream(model, context, { ...options, signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : []), AbortSignal.timeout(120000)]) });
        };
      }
      let writes = Promise.resolve(); let writeError: unknown;
      // Agent-core awaits subscribers; persistence completes before tool execution or the next model call.
      const unsubscribe = tools ? current.agent.subscribe(async event => {
        try {
          if (event.type === 'message_end' && (event.message.role === 'user' || event.message.role === 'assistant' || event.message.role === 'toolResult' || event.message.role === 'custom')) await tools.message(event.message);
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') await delta(event.assistantMessageEvent.delta);
        } catch (error) { stop(error instanceof Error ? error : new Error('output_limit')); throw error; }
      }) : current.subscribe(event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          const text = event.assistantMessageEvent.delta;
          writes = writes.then(() => delta(text)).catch(error => { writeError = error; abort(); });
        }
      });
      try {
        signal.throwIfAborted();
        if (input.run.input.continuation) {
          await current.sendCustomMessage({ customType: 'mochi-task-continuation', content: input.run.input.prompt, display: true,
            details: { source_message_id: input.run.input.scope!.source_message_id, task_id: input.run.input.scope!.task_id, phase: 'execute' } }, { triggerTurn: true });
        } else await current.prompt(input.run.input.prompt, { expandPromptTemplates: false });
        await writes;
        if (fatal) throw fatal;
        if (writeError) throw writeError;
        signal.throwIfAborted();
        const last = current.messages.at(-1);
        if (!last || last.role !== 'assistant' || last.stopReason !== 'stop') throw new Error('incomplete_output');
        const text = last.content.filter(part => part.type === 'text').map(part => part.text).join('');
        const raw = last.usage;
        const usage: Usage | null = raw && [raw.input, raw.output, raw.cacheRead, raw.cacheWrite, raw.totalTokens].every(Number.isFinite) && raw.totalTokens > 0
          ? { input: raw.input, output: raw.output, cache_read: raw.cacheRead, cache_write: raw.cacheWrite, total_tokens: raw.totalTokens } : null;
        return { text, usage: tools ? tools.usage : usage, ...(tools ? { usage_complete: tools.usageComplete } : {}) };
      } finally { unsubscribe(); current.agent.streamFunction = baseStream; signal.removeEventListener('abort', abort); }
    } finally {
      if (entry) entry.delegate = undefined;
      else { session?.dispose(); await rm(root, { recursive: true, force: true }); }
    }
  };
  execute.close = async () => {
    for (const entry of cached.values()) { entry.session.dispose(); await rm(entry.root, { recursive: true, force: true }); }
    cached.clear();
  };
  return execute;
}
