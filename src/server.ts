import { randomUUID } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { AccessError } from './auth.ts';

interface ServerOptions {
  authenticate: (authorization: string | undefined) => Promise<{ appId: string }>;
  isReady: () => boolean;
  log: (event: { event: 'request'; request_id: string; status: number; duration_ms: number }) => void;
}

export function createServer(options: ServerOptions) {
  return httpServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    const respond = (status: number, body: object) => {
      res.writeHead(status, {
        'content-type': 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'x-request-id': requestId,
        ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
      });
      res.end(JSON.stringify(body));
    };
    res.once('finish', () => options.log({
      event: 'request', request_id: requestId, status: res.statusCode,
      duration_ms: Math.round(performance.now() - started),
    }));
    try {
      const url = new URL(req.url ?? '/', 'http://mochi.internal');
      if (req.method === 'GET' && url.pathname === '/health/live') return respond(200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/health/ready') {
        return options.isReady() ? respond(200, { status: 'ok' }) : respond(503, { status: 'not_ready' });
      }
      if (req.headersDistinct.authorization?.length !== 1) throw new AccessError(401);
      await options.authenticate(req.headers.authorization);
      if ('x-app-id' in req.headers || url.searchParams.has('app_id')
        || url.pathname === '/admin' || url.pathname.startsWith('/admin/')) throw new AccessError(403);
      respond(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof AccessError) respond(error.status, { error: error.message });
      else respond(500, { error: 'internal_error' });
    }
  });
}
