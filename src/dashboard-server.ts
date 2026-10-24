import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createServer as httpServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { join } from 'node:path';
import {
  PUBLIC_FILE_LIMIT,
  PUBLIC_STALE_MS,
  parsePublicData,
  parsePublicHistory,
  type PublicData,
} from './dashboard-data.js';
import type { DashboardConfig } from './dashboard-config.js';

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'";
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/assets/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/assets/preview.png', ['preview.png', 'image/png']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
] as const);
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export async function createDashboard(config: DashboardConfig, now: () => number = Date.now) {
  const staticAssets = new Map<string, { body: Buffer; type: string }>();
  for (const [route, [file, type]] of assets) {
    let body = await readFile(join(config.assetPath, file));
    if (route === '/')
      body = Buffer.from(
        body.toString('utf8').replaceAll('__PUBLIC_URL__', escapeAttribute(config.publicUrl)),
      );
    staticAssets.set(route, { body, type });
  }
  let cached: PublicData | null = null;
  let loadedAt = -Infinity;
  let reading: Promise<void> | null = null;
  async function readPublicFile(path: string): Promise<unknown> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > PUBLIC_FILE_LIMIT) throw new Error('InvalidPublicData');
      const data = await file.readFile('utf8');
      if (Buffer.byteLength(data) > PUBLIC_FILE_LIMIT) throw new Error('InvalidPublicData');
      return JSON.parse(data) as unknown;
    } finally {
      await file.close();
    }
  }
  async function refresh(): Promise<void> {
    if (now() - loadedAt < 5000) return;
    if (reading) return reading;
    reading = (async () => {
      try {
        const data = parsePublicData(await readPublicFile(config.dataFile));
        data.history = await readPublicFile(join(config.dataFile, '..', 'history.json'))
          .then(parsePublicHistory)
          .catch(() => cached?.history ?? null);
        cached = data;
      } catch {
        /* Keep the last validated snapshot and let its timestamp become stale. */
      }
      loadedAt = now();
    })();
    try {
      await reading;
    } finally {
      reading = null;
    }
  }
  function send(
    response: ServerResponse,
    method: string,
    status: number,
    type: string,
    body: Buffer | string,
  ): void {
    response.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      ...(config.tls ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    response.end(method === 'HEAD' ? undefined : body);
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method || '';
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(response, method, 405, 'text/plain', 'Method not allowed');
      return;
    }
    const path = (request.url || '').split('?')[0]!;
    if (path.length > 1024) {
      send(response, method, 414, 'text/plain', 'URI too long');
      return;
    }
    if (path === '/healthz') {
      send(response, method, 200, 'application/json', '{"ok":true}');
      return;
    }
    if (path === '/robots.txt') {
      send(response, method, 200, 'text/plain', 'User-agent: *\nAllow: /\n');
      return;
    }
    if (path === '/api/metrics') {
      await refresh();
      if (!cached) {
        send(
          response,
          method,
          503,
          'application/json',
          '{"status":{"state":"unavailable"},"data":null}',
        );
        return;
      }
      const age = now() - cached.live.capturedAt;
      send(
        response,
        method,
        200,
        'application/json',
        JSON.stringify({
          status: {
            state: age >= -5000 && age <= PUBLIC_STALE_MS ? 'live' : 'stale',
            ageSeconds: Math.max(0, Math.floor(age / 1000)),
          },
          data: cached,
        }),
      );
      return;
    }
    const asset = staticAssets.get(path);
    if (asset) {
      send(response, method, 200, asset.type, asset.body);
      return;
    }
    send(response, method, 404, 'text/plain', 'Not found');
  }
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    handle(request, response).catch(() => {
      if (!response.headersSent)
        send(response, request.method || '', 503, 'text/plain', 'Temporarily unavailable');
      else response.destroy();
    });
  };
  const options = {
    maxHeaderSize: 8192,
    headersTimeout: 10_000,
    requestTimeout: 10_000,
    keepAliveTimeout: 5000,
  };
  const server = config.tls
    ? httpsServer(
        {
          ...options,
          minVersion: 'TLSv1.2',
          cert: await readFile(config.tls.cert),
          key: await readFile(config.tls.key),
        },
        listener,
      )
    : httpServer(options, listener);
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 40;
  return server;
}
