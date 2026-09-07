import { loadConfig } from './config.ts';
import { createAuthenticator } from './auth.ts';
import { createServer } from './server.ts';

function log(event: object) { process.stdout.write(`${JSON.stringify(event)}\n`); }

try {
  const config = loadConfig(process.env);
  const server = createServer({
    authenticate: createAuthenticator(config.auth),
    isReady: () => false,
    log,
  });
  server.on('error', () => {
    log({ event: 'startup_failed' });
    process.exitCode = 1;
  });
  server.listen(config.port, '0.0.0.0', () => log({ event: 'listening', port: config.port }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    log({ event: 'shutdown', signal });
    server.close();
    const timer = setTimeout(() => server.closeAllConnections(), 10000);
    timer.unref();
  });
} catch {
  log({ event: 'startup_failed', error: 'invalid_configuration' });
  process.exitCode = 1;
}
