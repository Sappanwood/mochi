import { readFile } from 'node:fs/promises';
import { FileCredentials } from './credential-store.ts';
import { createPi } from './pi.ts';
import { loadAdminConfig, adminAuthenticator } from './admin-auth.ts';
import { AdminControl } from './admin-control.ts';
import { createAdminServer } from './admin-server.ts';
import type { AdminAsset } from './admin-server.ts';

const log = (entry: object) => { process.stdout.write(`${JSON.stringify(entry)}\n`); };
let credentials: FileCredentials | undefined;
try {
  const config = loadAdminConfig(process.env);
  const assets = new Map<string, AdminAsset>();
  for (const [path, name, type] of [
    ['/', 'admin.html', 'text/html; charset=utf-8'],
    ['/admin.js', 'admin.js', 'text/javascript; charset=utf-8'],
    ['/admin.css', 'admin.css', 'text/css; charset=utf-8'],
  ]) assets.set(path!, { type: type!, body: await readFile(new URL(`./web/${name}`, import.meta.url)) });
  credentials = await FileCredentials.open(config.authDir);
  const owner = credentials;
  const pi = await createPi(owner);
  const control = new AdminControl(pi, owner.signal);
  let stopping = false;
  const server = createAdminServer({ config, assets, control, authenticate: adminAuthenticator(config),
    isReady: () => !stopping && !owner.signal.aborted, log,
  });
  async function shutdown() {
    if (stopping) return;
    stopping = true; server.close();
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 45000);
    deadline.unref();
    try { await control.close(); await owner.release(); }
    catch { log({ event: 'shutdown_incomplete' }); process.exitCode = 1; }
    finally { server.closeAllConnections(); clearTimeout(deadline); }
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void shutdown(); });
  owner.signal.addEventListener('abort', () => { void shutdown(); }, { once: true });
  server.on('error', () => { log({ event: 'startup_failed' }); process.exitCode = 1; void shutdown(); });
  server.listen(config.port, '0.0.0.0', () => log({ event: 'admin_listening', port: config.port }));
} catch {
  log({ event: 'startup_failed' }); process.exitCode = 1;
  await credentials?.release().catch(() => {});
}
