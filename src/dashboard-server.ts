import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createServer as httpServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { dirname, join } from 'node:path';
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
/**
 * page: the HTML, always revalidated (a cheap 304) so a deploy shows up at once.
 * versioned: referenced as ?v=<content hash>, so it can be cached forever under that URL.
 * static: rarely changes and is fetched without a version (social preview, icon).
 */
type Policy = 'page' | 'versioned' | 'static';
const assets = new Map<string, readonly [file: string, type: string, policy: Policy]>([
  ['/', ['index.html', 'text/html; charset=utf-8', 'page']],
  ['/assets/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8', 'versioned']],
  ['/assets/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8', 'versioned']],
  ['/assets/chart-model.js', ['chart-model.js', 'text/javascript; charset=utf-8', 'versioned']],
  [
    '/assets/fonts/ibm-plex-sans-latin-400-normal.woff2',
    ['fonts/ibm-plex-sans-latin-400-normal.woff2', 'font/woff2', 'versioned'],
  ],
  [
    '/assets/fonts/ibm-plex-sans-latin-600-normal.woff2',
    ['fonts/ibm-plex-sans-latin-600-normal.woff2', 'font/woff2', 'versioned'],
  ],
  ['/assets/fonts/OFL.txt', ['fonts/OFL.txt', 'text/plain; charset=utf-8', 'static']],
  [
    '/assets/fonts/league-spartan-bold.woff2',
    ['fonts/league-spartan-bold.woff2', 'font/woff2', 'versioned'],
  ],
  [
    '/assets/fonts/league-spartan-OFL.txt',
    ['fonts/league-spartan-OFL.txt', 'text/plain; charset=utf-8', 'static'],
  ],
  ['/assets/preview.png', ['preview.png', 'image/png', 'static']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml', 'static']],
]);
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
function entityTag(body: Buffer | string): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 20)}"`;
}
function matchesTag(header: string | undefined, tag: string): boolean {
  return (header ?? '')
    .split(',')
    .some((candidate) => candidate.trim() === '*' || candidate.trim().replace(/^W\//, '') === tag);
}
interface SendOptions {
  cache?: string;
  etag?: string;
}

export async function createDashboard(config: DashboardConfig, now: () => number = Date.now) {
  const raw = new Map<string, { body: Buffer; type: string; policy: Policy }>();
  const digest = createHash('sha256');
  for (const [route, [file, type, policy]] of assets) {
    const body = await readFile(join(config.assetPath, file));
    raw.set(route, { body, type, policy });
    digest.update(route).update(body);
  }
  // One hash of every asset: any change to any file produces new, uncached URLs.
  const assetVersion = digest.digest('base64url').slice(0, 12);
  const staticAssets = new Map<
    string,
    { body: Buffer; type: string; policy: Policy; etag: string }
  >();
  for (const [route, { body: original, type, policy }] of raw) {
    let body = original;
    if (/^text\/(html|css|javascript)/.test(type)) {
      let text = body.toString('utf8').replaceAll('__ASSET_VERSION__', assetVersion);
      if (route === '/')
        text = text.replaceAll('__PUBLIC_URL__', escapeAttribute(config.publicUrl));
      body = Buffer.from(text);
    }
    staticAssets.set(route, { body, type, policy, etag: entityTag(body) });
  }
  let cached: PublicData | null = null;
  let historyBody: string | null = null;
  let historyTag = '';
  let historyStamp: number | null = null;
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
        data.history = await readPublicFile(join(dirname(config.dataFile), 'history.json'))
          .then(parsePublicHistory)
          .catch(() => cached?.history ?? null);
        cached = data;
        // History changes every few minutes; serialize and tag it only when it does.
        const stamp = data.history?.generatedAt ?? null;
        if (stamp !== historyStamp) {
          historyStamp = stamp;
          historyBody = data.history ? JSON.stringify(data.history) : null;
          historyTag = historyBody ? entityTag(historyBody) : '';
        }
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
  function statusOf(data: PublicData): { state: 'live' | 'stale'; ageSeconds: number } {
    const age = now() - data.live.capturedAt;
    return {
      state: age >= -5000 && age <= PUBLIC_STALE_MS ? 'live' : 'stale',
      ageSeconds: Math.max(0, Math.floor(age / 1000)),
    };
  }
  function send(
    response: ServerResponse,
    method: string,
    status: number,
    type: string,
    body: Buffer | string,
    options: SendOptions = {},
  ): void {
    const notModified = status === 304;
    response.writeHead(status, {
      ...(notModified ? {} : { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }),
      'Cache-Control': options.cache ?? 'no-store',
      ...(options.etag ? { ETag: options.etag } : {}),
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      ...(config.tls ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    response.end(method === 'HEAD' || notModified ? undefined : body);
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method || '';
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(response, method, 405, 'text/plain', 'Method not allowed');
      return;
    }
    const target = request.url || '';
    const queryStart = target.indexOf('?');
    const path = queryStart < 0 ? target : target.slice(0, queryStart);
    if (path.length > 1024) {
      send(response, method, 414, 'text/plain', 'URI too long');
      return;
    }
    const requestedVersion =
      queryStart < 0 ? null : new URLSearchParams(target.slice(queryStart + 1)).get('v');
    const conditional = request.headers['if-none-match'];
    if (path === '/healthz') {
      send(response, method, 200, 'application/json', '{"ok":true}');
      return;
    }
    if (path === '/robots.txt') {
      send(response, method, 200, 'text/plain', 'User-agent: *\nAllow: /\n', {
        cache: 'public, max-age=3600',
      });
      return;
    }
    if (path === '/api/metrics' || path === '/api/live') {
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
      // /api/metrics is the complete snapshot. /api/live omits the ~45 KB history, which only
      // changes every few minutes, and says when a newer history is available.
      const { history, ...live } = cached;
      send(
        response,
        method,
        200,
        'application/json',
        JSON.stringify({
          status: statusOf(cached),
          data:
            path === '/api/metrics'
              ? cached
              : { ...live, historyGeneratedAt: history?.generatedAt ?? null },
        }),
      );
      return;
    }
    if (path === '/api/history') {
      await refresh();
      if (!historyBody) {
        send(response, method, 503, 'application/json', '{"history":null}');
        return;
      }
      const options = { cache: 'no-cache', etag: historyTag };
      if (matchesTag(conditional, historyTag))
        send(response, method, 304, 'application/json', '', options);
      else send(response, method, 200, 'application/json', historyBody, options);
      return;
    }
    const asset = staticAssets.get(path);
    if (asset) {
      const cache =
        asset.policy === 'page'
          ? 'no-cache'
          : asset.policy === 'versioned' && requestedVersion === assetVersion
            ? 'public, max-age=31536000, immutable'
            : asset.policy === 'static'
              ? 'public, max-age=3600'
              : 'public, max-age=300';
      const options = { cache, etag: asset.etag };
      if (matchesTag(conditional, asset.etag)) send(response, method, 304, asset.type, '', options);
      else send(response, method, 200, asset.type, asset.body, options);
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
