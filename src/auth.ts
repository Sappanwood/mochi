import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from './config.ts';

export class AccessError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403) {
    super(status === 401 ? 'unauthorized' : 'forbidden');
    this.status = status;
  }
}

export function createAuthenticator(config: AuthConfig, getKey: JWTVerifyGetKey = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${config.tenant}/discovery/v2.0/keys`),
  { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 },
)) {
  return async (authorization: string | undefined): Promise<{ appId: string }> => {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization ?? '');
    if (!match?.[1]) throw new AccessError(401);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(match[1], getKey, {
        algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['exp', 'nbf', 'iat', 'tid', 'ver'],
      }));
    } catch { throw new AccessError(401); }
    if (payload.tid !== config.tenant || payload.ver !== '2.0') throw new AccessError(401);
    if ('scp' in payload || (payload.idtyp !== undefined && payload.idtyp !== 'app')
      || !Array.isArray(payload.roles) || !payload.roles.every((role: unknown) => typeof role === 'string')
      || !payload.roles.includes(config.role)) throw new AccessError(403);
    const caller = typeof payload.azp === 'string' ? config.callers.get(payload.azp) : undefined;
    if (!caller || payload.oid !== caller.principalId) throw new AccessError(403);
    return { appId: caller.appId };
  };
}
