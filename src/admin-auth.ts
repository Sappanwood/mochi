import { isAbsolute, resolve } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { AccessError } from './auth.ts';

export function loadAdminConfig(env: NodeJS.ProcessEnv) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const issuer = env.MOCHI_ENTRA_ISSUER ?? '';
  const tenant = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/.exec(issuer)?.[1] ?? '';
  const audience = env.MOCHI_ADMIN_AUDIENCE ?? '';
  const clientId = env.MOCHI_ADMIN_CLIENT_ID ?? '';
  const oid = env.MOCHI_ADMIN_OID ?? '';
  const origin = env.MOCHI_ADMIN_ORIGIN ?? '';
  const authDir = env.MOCHI_AUTH_DIR ?? '';
  const portText = env.PORT ?? '8080';
  const port = Number(portText);
  try {
    const url = new URL(origin);
    if (![tenant, audience, clientId, oid].every(value => uuid.test(value))
      || url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
      || !isAbsolute(authDir) || resolve(authDir) !== authDir
      || !/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error();
  } catch { throw new Error('invalid_admin_configuration'); }
  return { issuer, tenant, audience, clientId, oid, origin, authDir, port, scope: 'Mochi.Manage' };
}

export type AdminConfig = ReturnType<typeof loadAdminConfig>;
export interface AdminIdentity { oid: string; expires: number }

export function adminAuthenticator(config: AdminConfig, keys: JWTVerifyGetKey = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${config.tenant}/discovery/v2.0/keys`), { timeoutDuration: 5000 },
)) {
  return async (header: string | undefined): Promise<AdminIdentity> => {
    const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header ?? '')?.[1];
    if (!token) throw new AccessError(401);
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['exp', 'nbf', 'iat', 'tid', 'ver'],
      }));
    } catch { throw new AccessError(401); }
    if (payload.tid !== config.tenant || payload.ver !== '2.0') throw new AccessError(401);
    if (payload.oid !== config.oid || payload.azp !== config.clientId || payload.idtyp === 'app'
      || typeof payload.scp !== 'string' || !payload.scp.split(' ').includes(config.scope)) throw new AccessError(403);
    return { oid: config.oid, expires: payload.exp! * 1000 };
  };
}
