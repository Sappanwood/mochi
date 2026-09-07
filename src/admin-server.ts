import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AdminConfig, AdminIdentity } from './admin-auth.ts';
import type { AdminControl } from './admin-control.ts';
import { AccessError } from './auth.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'json_required');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new HttpError(413, 'request_too_large');
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new HttpError(400, 'invalid_request'); }
}

export interface AdminAsset { type: string; body: string | Buffer }
export function createAdminServer(options: {
  config: AdminConfig; control: AdminControl;
  authenticate: (header: string | undefined) => Promise<AdminIdentity>;
  isReady: () => boolean; assets: Map<string, AdminAsset>; log: (entry: object) => void;
}) {
  return createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https://login.microsoftonline.com; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => options.log({ event: 'admin_request', request_id: requestId, status: res.statusCode }));
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://mochi.internal');
      const path = url.pathname;
      const rawPath = (req.url ?? '/').split('?')[0]!;
      if (rawPath !== path || /[%\\]/.test(rawPath) || rawPath.includes('//')) throw new HttpError(400, 'invalid_path');
      if (req.method === 'GET') {
        const asset = options.assets.get(path);
        if (asset) { res.writeHead(200, { 'content-type': asset.type }); res.end(asset.body); return; }
        if (path === '/health/live') return send(200, { status: 'ok' });
        if (path === '/health/ready') return send(options.isReady() ? 200 : 503, { status: options.isReady() ? 'ok' : 'not_ready' });
        if (path === '/admin/config') return send(200, { clientId: options.config.clientId, tenant: options.config.tenant,
          scope: `api://${options.config.audience}/${options.config.scope}`, origin: options.config.origin });
      }
      if (req.headersDistinct.authorization?.length !== 1) throw new AccessError(401);
      const identity = await options.authenticate(req.headers.authorization);
      if ((req.headers.origin && req.headers.origin !== options.config.origin)
        || req.headers['x-mochi-request'] !== '1'
        || (req.method !== 'GET' && req.headers.origin !== options.config.origin)) throw new AccessError(403);
      if (url.search) throw new HttpError(400, 'invalid_request');
      if (!options.isReady()) return send(503, { error: 'not_ready' });
      const input = req.method === 'GET' ? {} : await body(req);
      if (path === '/admin/session' && req.method === 'POST') return send(201, options.control.createSession(identity));
      const session = req.headers['x-mochi-session'];
      if (typeof session !== 'string') throw new AccessError(401);
      options.control.authorize(session, identity);
      if (path === '/admin/session' && req.method === 'DELETE') { options.control.endSession(session); return send(200, { ok: true }); }
      if (path === '/admin/providers' && req.method === 'GET') return send(200, await options.control.providers(session));
      if (path === '/admin/providers/deepseek/key' && req.method === 'POST') {
        if (typeof input.key !== 'string' || Object.keys(input).length !== 1) throw new HttpError(400, 'invalid_request');
        await options.control.saveKey(session, input.key); return send(200, { ok: true });
      }
      if (path === '/admin/providers/openai-codex/refresh' && req.method === 'POST') {
        if (Object.keys(input).length !== 0) throw new HttpError(400, 'invalid_request');
        await options.control.refreshOpenAI(session); return send(200, { ok: true });
      }
      if (path === '/admin/providers/openai-codex/login' && req.method === 'POST') return send(202, options.control.startOpenAI(session));
      const logout = /^\/admin\/providers\/(deepseek|openai-codex)\/logout$/.exec(path);
      if (logout && req.method === 'POST') { await options.control.logout(session, logout[1]!); return send(200, { ok: true }); }
      const txn = /^\/admin\/oauth\/([A-Za-z0-9_-]+)(\/cancel)?$/.exec(path);
      if (txn && req.method === 'GET' && !txn[2]) return send(200, options.control.transaction(session, txn[1]!));
      if (txn && req.method === 'POST' && txn[2]) { options.control.cancel(session, txn[1]!); return send(200, { ok: true }); }
      send(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof AccessError || error instanceof HttpError) send(error.status, { error: error.message });
      else if (error instanceof Error && ['provider_busy', 'session_limit'].includes(error.message)) send(409, { error: error.message });
      else if (error instanceof Error && ['invalid_key', 'invalid_credential'].includes(error.message)) send(400, { error: 'invalid_key' });
      else if (error instanceof Error && error.message === 'authentication_required') send(409, { error: 'reauthentication_required' });
      else send(500, { error: 'operation_failed' });
    }
  });
}
