import { readFile } from 'node:fs/promises';
import type { RequestListener } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { loadServiceConfig } from './service-config.ts';
import { createAuthenticator } from './auth.ts';
import { createServer } from './server.ts';
import { adminAuthenticator } from './admin-auth.ts';
import { createAdminServer } from './admin-server.ts';
import type { AdminAsset } from './admin-server.ts';
import { AdminControl } from './admin-control.ts';
import { FileCredentials } from './credential-store.ts';
import { createPi } from './pi.ts';
import { TaskStore } from './task-store.ts';
import { Tasks } from './tasks.ts';
import { AzureQueue } from './queue.ts';
import { piExecutor } from './executor.ts';
import { TaskError } from './task-types.ts';

const log = (event: object) => { process.stdout.write(`${JSON.stringify(event)}\n`); };
let credentials: FileCredentials | undefined;
let store: TaskStore | undefined;
try {
  const config = loadServiceConfig(process.env);
  const adminConfig = config.admin;
  const queue = AzureQueue.configured(process.env);
  const assets = new Map<string, AdminAsset>();
  if (adminConfig) for (const [path, name, type] of [
    ['/', 'admin.html', 'text/html; charset=utf-8'], ['/admin.js', 'admin.js', 'text/javascript; charset=utf-8'],
    ['/admin.css', 'admin.css', 'text/css; charset=utf-8'],
  ]) assets.set(path!, { type: type!, body: await readFile(new URL(`./web/${name}`, import.meta.url)) });
  credentials = await FileCredentials.open(config.authDir);
  store = await TaskStore.open(config.dataDir);
  const owner = credentials; const data = store;
  const pi = await createPi(owner);
  const control = adminConfig ? new AdminControl(pi, owner.signal) : undefined;
  const tasks = new Tasks(data, { send: id => queue.send(id, data.runs.get(id)!.app_id) }, pi.models, config.appTools);
  await tasks.recover();
  let stopping = false; let queueReady = false;
  const ready = () => !stopping && queueReady && !owner.signal.aborted && !data.signal.aborted;
  const admin = adminConfig && control ? createAdminServer({ config: adminConfig, assets, control, authenticate: adminAuthenticator(adminConfig), isReady: ready, log }) : undefined;
  const server = createServer({ authenticate: createAuthenticator(config.auth), isReady: ready, tasks,
    adminHandler: admin?.listeners('request')[0] as RequestListener | undefined, log });
  const controller = new AbortController();
  const execute = piExecutor(pi, config.appTools);
  let worker: Promise<void>;
  async function shutdown() {
    if (stopping) return;
    stopping = true; queueReady = false; controller.abort(); server.close();
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 45000); deadline.unref();
    try { await worker; await tasks.close(); await control?.close(); await data.close(); await owner.release(); }
    catch { log({ event: 'shutdown_incomplete' }); process.exitCode = 1; }
    finally { server.closeAllConnections(); clearTimeout(deadline); }
  }
  worker = (async () => {
    try {
      while (!controller.signal.aborted) {
        try { await tasks.reconcile(controller.signal); }
        catch (error) {
          if (!(error instanceof TaskError) || error.message !== 'queue_unavailable') throw error;
          queueReady = false;
          await delay(1000, undefined, { signal: controller.signal });
          continue;
        }
        if (controller.signal.aborted) break;
        const found = await queue.once(tasks, execute, controller.signal, 20000, () => { queueReady = true; });
        if (!found) await delay(1000, undefined, { signal: controller.signal });
      }
    } catch {
      queueReady = false;
      if (!controller.signal.aborted) { log({ event: 'worker_failed' }); process.exitCode = 1; setImmediate(() => { void shutdown(); }); }
    }
  })();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown(); });
  for (const signal of [owner.signal, data.signal]) signal.addEventListener('abort', () => { void shutdown(); }, { once: true });
  server.on('error', () => { log({ event: 'startup_failed' }); process.exitCode = 1; void shutdown(); });
  server.listen(config.port, '0.0.0.0', () => log({ event: 'listening', port: config.port }));
} catch {
  log({ event: 'startup_failed', error: 'invalid_configuration_or_storage' }); process.exitCode = 1;
  await store?.close().catch(() => {}); await credentials?.release().catch(() => {});
}
