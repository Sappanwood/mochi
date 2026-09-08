import { isAbsolute, resolve, sep } from 'node:path';
import { AppTools } from './app-tools.ts';
import { loadConfig } from './config.ts';
import { loadAdminConfig } from './admin-auth.ts';

export function loadServiceConfig(env: NodeJS.ProcessEnv) {
  const business = loadConfig(env);
  const admin = Object.keys(env).some(key => key.startsWith('MOCHI_ADMIN_') && env[key] !== undefined) ? loadAdminConfig(env) : undefined;
  const authDir = env.MOCHI_AUTH_DIR ?? '';
  const dataDir = env.MOCHI_DATA_DIR ?? '';
  if (![authDir, dataDir].every(path => isAbsolute(path) && resolve(path) === path) || dataDir === authDir
    || dataDir.startsWith(`${authDir}${sep}`) || authDir.startsWith(`${dataDir}${sep}`)) throw new Error('invalid_data_directory');
  return { ...business, admin, authDir, dataDir, appTools: AppTools.fromEnv(env) };
}
