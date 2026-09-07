const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AuthConfig {
  issuer: string;
  audience: string;
  tenant: string;
  role: 'Mochi.Invoke';
  callers: ReadonlyMap<string, { appId: string; principalId: string }>;
}

function invalid(field: string): never {
  throw new Error(`Invalid configuration: ${field}`);
}

export function loadConfig(env: NodeJS.ProcessEnv) {
  if (env.MOCHI_AUTH_MODE !== 'entra') invalid('MOCHI_AUTH_MODE');
  const issuer = env.MOCHI_ENTRA_ISSUER ?? '';
  const match = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/.exec(issuer);
  const tenant = match?.[1];
  if (!tenant || !uuid.test(tenant)) invalid('MOCHI_ENTRA_ISSUER');
  const audience = env.MOCHI_ENTRA_AUDIENCE ?? '';
  if (!uuid.test(audience)) invalid('MOCHI_ENTRA_AUDIENCE');
  if (env.MOCHI_ENTRA_ROLE !== 'Mochi.Invoke') invalid('MOCHI_ENTRA_ROLE');
  let mapping: unknown;
  try { mapping = JSON.parse(env.MOCHI_ENTRA_CALLERS ?? ''); }
  catch { invalid('MOCHI_ENTRA_CALLERS'); }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) invalid('MOCHI_ENTRA_CALLERS');
  const callers = new Map<string, { appId: string; principalId: string }>();
  const principals = new Set<string>();
  for (const [appId, value] of Object.entries(mapping)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(appId) || !value || typeof value !== 'object' || Array.isArray(value)) {
      invalid('MOCHI_ENTRA_CALLERS');
    }
    const { client_id: clientId, principal_id: principalId } = value as Record<string, unknown>;
    if (Object.keys(value).length !== 2 || typeof clientId !== 'string' || !uuid.test(clientId)
      || typeof principalId !== 'string' || !uuid.test(principalId)
      || callers.has(clientId) || principals.has(principalId)) invalid('MOCHI_ENTRA_CALLERS');
    callers.set(clientId, { appId, principalId });
    principals.add(principalId);
  }
  if (callers.size === 0) invalid('MOCHI_ENTRA_CALLERS');
  const portText = env.PORT ?? '8080';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) invalid('PORT');
  const auth: AuthConfig = { issuer, audience, tenant, role: 'Mochi.Invoke', callers };
  return { port, auth };
}
