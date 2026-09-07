import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { build } from 'esbuild';
import { FileCredentials } from '../src/credential-store.ts';
import { createPi } from '../src/pi.ts';
import { AdminControl } from '../src/admin-control.ts';
import { createAdminServer } from '../src/admin-server.ts';
import type { AdminConfig } from '../src/admin-auth.ts';
import { AccessError } from '../src/auth.ts';

const root = await mkdtemp(join(tmpdir(), 'mochi-browser-'));
const store = await FileCredentials.open(root);
const pi = await createPi(store);
pi.runtime.getProvider('openai-codex')!.auth.oauth!.login = async interaction => {
  await interaction.prompt({ type: 'select', message: 'method', options: [{ id: 'device_code', label: 'Device' }] });
  interaction.notify({ type: 'device_code', userCode: 'MOCK-1234', verificationUri: 'https://auth.openai.com/codex/device' });
  await setTimeout(5000, undefined, { signal: interaction.signal });
  return { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 };
};
pi.runtime.getProvider('openai-codex')!.auth.oauth!.refresh = async (_credential, signal) => {
  await setTimeout(500, undefined, { signal });
  return { type: 'oauth', access: 'fixture-rotated', refresh: 'fixture-rotated', expires: Date.now() + 3600000 };
};
const control = new AdminControl(pi, store.signal);
const bundle = await build({ stdin: { contents: `import { mountAdmin } from './src/admin-app.ts'; let signed=false; mountAdmin({async token(interactive){ if(interactive) signed=true; return signed?'fixture':null; },async logout(){signed=false;}});`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const config = { origin: '', tenant: 'fixture', clientId: 'fixture', audience: 'fixture', scope: 'Mochi.Manage' } as AdminConfig;
const server = createAdminServer({ config, control, isReady: () => !store.signal.aborted,
  authenticate: async header => { if (header !== 'Bearer fixture') throw new AccessError(401); return { oid: 'fixture', expires: Date.now() + 600000 }; },
  assets: new Map([
    ['/', { type: 'text/html', body: await readFile('src/admin.html') }],
    ['/admin.css', { type: 'text/css', body: await readFile('src/admin.css') }],
    ['/admin.js', { type: 'text/javascript', body: Buffer.from(bundle.outputFiles![0]!.contents) }],
  ]), log: () => {},
});
server.listen(0, '127.0.0.1', () => {
  config.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.stdout.write(`${config.origin}\n`);
});
process.once('SIGTERM', async () => {
  server.closeAllConnections(); server.close(); await control.close(); await store.release(); await rm(root, { recursive: true, force: true });
});
