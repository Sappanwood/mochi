import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import type { AuthInteraction, Credential, CredentialStore } from '@earendil-works/pi-ai';

const providers = ['deepseek', 'openai-codex'] as const;
function validCredential(provider: string, credential: Credential | undefined): boolean {
  if (credential && 'mochiReauthenticationRequired' in credential
    && credential.mochiReauthenticationRequired === true) return false;
  if (provider === 'deepseek') return credential?.type === 'api_key'
    && typeof credential.key === 'string' && credential.key.trim().length > 0
    && !credential.key.startsWith('!') && !/[\r\n]/.test(credential.key);
  return provider === 'openai-codex' && credential?.type === 'oauth'
    && typeof credential.access === 'string' && credential.access.length > 0
    && typeof credential.refresh === 'string' && credential.refresh.length > 0
    && Number.isFinite(credential.expires);
}

export async function createPi(credentials: CredentialStore) {
  const guarded: CredentialStore = {
    async read(provider, options) {
      const credential = await credentials.read(provider, options);
      if (!validCredential(provider, credential)) throw new Error('authentication_required');
      return credential;
    },
    list: options => credentials.list(options),
    async modify(provider, fn, options) {
      let failed = false;
      const result = await credentials.modify(provider, async current => {
        options?.signal?.throwIfAborted();
        if (!validCredential(provider, current)) throw new Error('authentication_required');
        try {
          const next = await fn(current);
          options?.signal?.throwIfAborted();
          if (next !== undefined && !validCredential(provider, next)) throw new Error('authentication_required');
          return next;
        } catch {
          if (current?.type !== 'oauth') throw new Error('credential_operation_failed');
          // Persist uncertainty under the same lock, even when the request was cancelled.
          failed = true;
          return { ...current, mochiReauthenticationRequired: true };
        }
      });
      if (failed) throw new Error('authentication_required');
      return result;
    },
    delete: (provider, options) => credentials.delete(provider, options),
  };
  const runtime = await ModelRuntime.create({
    credentials: guarded, modelsPath: null, modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  return {
    runtime,
    async login(provider: string, interaction: AuthInteraction): Promise<void> {
      if (!providers.some(id => id === provider)) throw new Error('unsupported_provider');
      const auth = runtime.getProvider(provider)!.auth;
      const login = provider === 'deepseek' ? auth.apiKey?.login : auth.oauth?.login;
      if (!login) throw new Error('unsupported_provider');
      const timeout = AbortSignal.timeout(300000);
      const signal = interaction.signal ? AbortSignal.any([interaction.signal, timeout]) : timeout;
      try {
        await credentials.modify(provider, async () => {
          signal.throwIfAborted();
          const credential = await login({ ...interaction, signal });
          signal.throwIfAborted();
          if (!validCredential(provider, credential)) throw new Error('invalid_credential');
          return credential;
        }, { signal });
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_credential') throw error;
        throw new Error('credential_operation_failed');
      }
    },
    async refreshOpenAI(requestSignal?: AbortSignal): Promise<void> {
      const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(requestSignal ? [requestSignal] : [])]);
      try {
        await guarded.modify('openai-codex', async current => {
          if (current?.type !== 'oauth') throw new Error('authentication_required');
          const next = await runtime.getProvider('openai-codex')!.auth.oauth!.refresh(current, signal);
          if (next.expires <= Date.now()) throw new Error('authentication_required');
          return next;
        }, { signal });
      } catch { throw new Error('authentication_required'); }
    },
    async logout(provider: string): Promise<void> {
      if (!providers.some(id => id === provider)) throw new Error('unsupported_provider');
      try { await credentials.delete(provider, { signal: AbortSignal.timeout(10000) }); }
      catch { throw new Error('credential_operation_failed'); }
    },
    models: () => providers.flatMap(provider => runtime.getModels(provider).map(model => ({
      provider, id: model.id, name: model.name, auth: provider === 'deepseek' ? 'api_key' : 'oauth',
      context_window: model.contextWindow, max_output_tokens: model.maxTokens,
    }))),
    async status() {
      return Promise.all(providers.map(async provider => ({
        provider, auth: provider === 'deepseek' ? 'api_key' : 'oauth',
        configured: validCredential(provider, await credentials.read(provider)),
      })));
    },
    async requireModel(provider: string, modelId: string) {
      if (!providers.some(id => id === provider)) throw new Error('unsupported_model');
      const model = runtime.getModel(provider, modelId);
      if (!model) throw new Error('unsupported_model');
      await guarded.read(provider);
      return model;
    },
  };
}

export type Pi = Awaited<ReturnType<typeof createPi>>;

export async function openConversation(pi: Pi, input: {
  cwd: string; agentDir: string; provider: string; model: string; sessionId?: string; systemPrompt?: string; maxOutputTokens?: number;
  history?: { role: 'user' | 'assistant'; content: string }[];
}) {
  const model = await pi.requireModel(input.provider, input.model);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd, agentDir: input.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: input.systemPrompt ?? 'You are Mochi, a conversational assistant. You have no tools or filesystem access.',
    appendSystemPrompt: [],
  });
  await resourceLoader.reload();
  const manager = SessionManager.inMemory(input.cwd);
  for (const message of input.history ?? []) {
    if (message.role === 'user') manager.appendMessage({ role: 'user', content: message.content, timestamp: Date.now() });
    else manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: message.content }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  const { session } = await createAgentSession({
    cwd: input.cwd, agentDir: input.agentDir, modelRuntime: pi.runtime, model,
    tools: [], noTools: 'all', customTools: [], resourceLoader, settingsManager,
    sessionManager: manager,
  });
  if (session.getActiveToolNames().length !== 0) {
    session.dispose();
    throw new Error('unexpected_tools');
  }
  if (input.maxOutputTokens !== undefined || input.systemPrompt !== undefined) {
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => stream(model,
      { ...context, systemPrompt: input.systemPrompt ?? context.systemPrompt },
      { ...options, maxTokens: input.maxOutputTokens, sessionId: input.sessionId ?? options?.sessionId });
  }
  return session;
}
