import { QueueClient } from '@azure/storage-queue';
import { ManagedIdentityCredential } from '@azure/identity';
import type { Tasks, Execute } from './tasks.ts';

export function queueConfig(env: NodeJS.ProcessEnv) {
  const url = new URL(env.MOCHI_QUEUE_ACCOUNT_URL ?? '');
  const name = env.MOCHI_QUEUE_NAME ?? '';
  if (url.protocol !== 'https:' || !/^[a-z0-9]{3,24}\.queue\.core\.windows\.net$/.test(url.hostname)
    || url.pathname !== '/' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name) || name.includes('--')
    || url.search || url.hash || url.username || url.password || url.port) throw new Error('invalid_queue_configuration');
  const clientId = env.AZURE_CLIENT_ID;
  if (clientId !== undefined && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(clientId)) throw new Error('invalid_queue_configuration');
  return { url: `${url.origin}/${name}`, clientId };
}
export type QueuePort = Pick<QueueClient, 'sendMessage' | 'receiveMessages' | 'updateMessage' | 'deleteMessage'>;
export class AzureQueue {
  readonly client: QueuePort;
  constructor(client: QueuePort) { this.client = client; }
  static configured(env: NodeJS.ProcessEnv) {
    const config = queueConfig(env);
    return new AzureQueue(new QueueClient(config.url, new ManagedIdentityCredential(config.clientId ? { clientId: config.clientId } : {}),
      { retryOptions: { maxTries: 1 }, keepAliveOptions: { enable: true } }));
  }
  async send(runId: string, appId: string) {
    await this.client.sendMessage(Buffer.from(JSON.stringify({ schema_version: 1, app_id: appId, run_id: runId })).toString('base64'),
      { messageTimeToLive: -1, abortSignal: AbortSignal.timeout(10000) });
  }
  async once(tasks: Tasks, execute: Execute, signal: AbortSignal, renewEvery = 20000, received: () => void = () => {}) {
    const response = await this.client.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 60, abortSignal: signal });
    received();
    const message = response.receivedMessageItems[0];
    if (!message) return false;
    let runId: string;
    try {
      const value = JSON.parse(Buffer.from(message.messageText, 'base64').toString('utf8')) as { schema_version: number; app_id: string; run_id: string };
      if (Object.keys(value).length !== 3 || value.schema_version !== 1 || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.app_id) || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.run_id)) throw new Error();
      runId = value.run_id;
      const saved = tasks.store.runs.get(runId);
      if (saved && saved.app_id !== value.app_id) throw new Error();
    } catch { throw new Error('invalid_queue_message'); }
    const controller = new AbortController();
    let receipt = message.popReceipt; let failed = false; let renewal = Promise.resolve();
    const renew = setInterval(() => {
      renewal = renewal.then(async () => {
        if (controller.signal.aborted) return;
        try {
          const updated = await this.client.updateMessage(message.messageId, receipt, undefined, 60,
            { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
          receipt = updated.popReceipt!;
        } catch { failed = true; controller.abort(); }
      });
    }, renewEvery);
    try {
      await tasks.execute(runId, execute, AbortSignal.any([signal, controller.signal]));
      clearInterval(renew); await renewal;
      if (failed) throw new Error('queue_lease_lost');
      await this.client.deleteMessage(message.messageId, receipt, { abortSignal: signal });
      return true;
    } finally { clearInterval(renew); await renewal; }
  }
}
