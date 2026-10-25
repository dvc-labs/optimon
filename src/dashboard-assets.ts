import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DashboardConfig } from './dashboard-config.js';

export const PUBLIC_CSP =
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
  ['/assets/availability.js', ['availability.js', 'text/javascript; charset=utf-8', 'versioned']],
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
export function entityTag(body: Buffer | string): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 20)}"`;
}
export function matchesTag(header: string | undefined, tag: string): boolean {
  return (header ?? '')
    .split(',')
    .some((candidate) => candidate.trim() === '*' || candidate.trim().replace(/^W\//, '') === tag);
}

export function publicHeaders(origin: 'dashboard' | 'fallback', tls = false) {
  return {
    'Content-Security-Policy': PUBLIC_CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Optimon-Origin': origin,
    ...(tls ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}

/** Both origins serve the same branding and fonts; only the fallback index differs. */
export async function loadDashboardAssets(
  config: Pick<DashboardConfig, 'assetPath' | 'publicUrl'>,
  fallback = false,
) {
  const selectedAssets = new Map(assets);
  if (fallback) {
    selectedAssets.set('/', ['../fallback/index.html', 'text/html; charset=utf-8', 'page']);
    selectedAssets.set('/fallback-assets/fallback.css', [
      '../fallback/fallback.css',
      'text/css; charset=utf-8',
      'versioned',
    ]);
    selectedAssets.set('/fallback-assets/fallback.js', [
      '../fallback/fallback.js',
      'text/javascript; charset=utf-8',
      'versioned',
    ]);
  }
  const raw = new Map<string, { body: Buffer; type: string; policy: Policy }>();
  const digest = createHash('sha256');
  for (const [route, [file, type, policy]] of selectedAssets) {
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
  return { staticAssets, assetVersion };
}
