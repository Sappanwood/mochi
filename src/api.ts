import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Tasks } from './tasks.ts';
import { TaskError, terminal } from './task-types.ts';

async function body(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new TaskError(415, 'json_required');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw new TaskError(413, 'request_too_large');
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new TaskError(400, 'invalid_request'); }
}
async function sse(tasks: Tasks, appId: string, runId: string, after: number, res: ServerResponse) {
  await tasks.events(appId, runId, after);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const until = Date.now() + 25000;
  let cursor = after;
  while (!res.destroyed && Date.now() < until) {
    const result = await tasks.events(appId, runId, cursor);
    for (const event of result.events) {
      if (!res.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)) {
        await new Promise<void>(resolve => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done); res.once('close', done);
        });
      }
    }
    cursor = result.next_cursor;
    if (terminal((await tasks.run(appId, runId)).status) && result.events.length < 100) break;
    if (!result.events.length) {
      res.write(': keepalive\n\n');
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, 300);
        function done() { clearTimeout(timer); res.off('close', done); resolve(); }
        res.once('close', done);
      });
    }
  }
  res.end();
}
export async function agentApi(tasks: Tasks, appId: string, req: IncomingMessage, res: ServerResponse,
  send: (status: number, value: object) => void) {
  const url = new URL(req.url!, 'http://mochi.internal');
  const path = url.pathname;
  if (path === '/v1/models' && req.method === 'GET' && !url.search) return send(200, { models: tasks.models() });
  if (path === '/v1/sessions' && req.method === 'POST' && !url.search) return send(201, await tasks.createSession(appId, await body(req)));
  if (path === '/v1/runs/by-key' && req.method === 'GET') {
    if (url.searchParams.size !== 1 || !url.searchParams.has('key') || !url.searchParams.get('key')) throw new TaskError(400, 'invalid_request');
    return send(200, await tasks.byKey(appId, url.searchParams.get('key')!));
  }
  const session = /^\/v1\/sessions\/([a-f0-9-]{36})(\/(history|runs))?$/.exec(path);
  if (session && !url.search) {
    if (req.method === 'GET' && !session[3]) return send(200, await tasks.session(appId, session[1]!));
    if (req.method === 'GET' && session[3] === 'history') return send(200, await tasks.history(appId, session[1]!));
    if (req.method === 'POST' && session[3] === 'runs') return send(202, await tasks.submit(appId, session[1]!, await body(req)));
  }
  const run = /^\/v1\/runs\/([a-f0-9-]{36})(\/(cancel|events))?$/.exec(path);
  if (run) {
    if (req.method === 'GET' && !run[3] && !url.search) return send(200, await tasks.run(appId, run[1]!));
    if (req.method === 'POST' && run[3] === 'cancel' && !url.search) {
      if (Object.keys(await body(req)).length) throw new TaskError(400, 'invalid_request');
      return send(200, await tasks.cancel(appId, run[1]!));
    }
    if (req.method === 'GET' && run[3] === 'events') {
      if (url.searchParams.size > 1 || (url.searchParams.size === 1 && !url.searchParams.has('after'))) throw new TaskError(400, 'invalid_cursor');
      const raw = url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '0';
      if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new TaskError(400, 'invalid_cursor');
      const after = Number(raw);
      if (req.headers.accept === 'text/event-stream') return sse(tasks, appId, run[1]!, after, res);
      return send(200, await tasks.events(appId, run[1]!, after));
    }
  }
  throw new TaskError(404, 'not_found');
}
