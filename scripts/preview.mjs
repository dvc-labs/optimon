// Local visual QA only. No Discord login, production database, secrets or external requests.
//   npm run build && node scripts/preview.mjs [--port 3000] [--host 0.0.0.0]
//     [--scenario normal|young|stale|hot]
// normal: ten days of history with two outages. young: forty minutes of history.
// stale: the last reading is 25 minutes old. hot: the CPU package is above the warning level.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createDashboard } from '../dist/dashboard-server.js';
import { loadDashboardConfig } from '../dist/dashboard-config.js';
import { queryDashboard } from '../dist/dashboard-query.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    scenario: { type: 'string' },
    strictPort: { type: 'boolean' },
  },
});
const port = Number(process.env.PORT || values.port || '3000');
// Loopback by default; pass --host 0.0.0.0 to reach it from a VM, container or phone.
const host = values.host || '127.0.0.1';
const scenario = values.scenario || 'normal';
if (!['normal', 'young', 'stale', 'hot'].includes(scenario)) {
  console.error('--scenario must be normal, young, stale or hot.');
  process.exit(1);
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const directory = await mkdtemp(join(tmpdir(), 'optiplex-preview-'));
const started = Date.now();
const firstMinute = Math.floor(
  (started - (scenario === 'young' ? 40 * MINUTE : 10 * DAY)) / MINUTE,
);

// Deterministic, so two runs draw the same pictures.
let seed = 7;
const noise = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

/** One minute of an idle home server: a nightly backup, a small midday job, a rare spike. */
function reading(at) {
  const date = new Date(at);
  const hour = date.getHours() + date.getMinutes() / 60;
  const ago = (started - at) / DAY;
  // A three-hour outage and a twelve-minute one.
  if ((ago > 5.5 && ago < 5.625) || (ago > 1.1 && ago < 1.108)) return null;
  let cpu = 1.4 + noise() * 1.6 + (noise() < 0.03 ? noise() * 18 : 0);
  if (hour > 3 && hour < 3.4) cpu += 18 + noise() * 8;
  if (hour > 12 && hour < 12.1) cpu += 6;
  const memory =
    12.3 + Math.sin(ago * 1.7) * 0.8 + noise() * 0.3 + (hour > 3 && hour < 3.4 ? 1.5 : 0);
  const temperature =
    31 + 4 * Math.sin(((hour - 9) / 24) * Math.PI * 2) + cpu * 0.28 + noise() * 0.8;
  // Now and then the sensor read fails and only the temperature is missing.
  return [+cpu.toFixed(1), +memory.toFixed(1), noise() < 0.004 ? null : +temperature.toFixed(1)];
}

const archive = new DatabaseSync(':memory:');
archive.exec(
  'CREATE TABLE metrics (at INTEGER PRIMARY KEY, cpu REAL, memory REAL, temperature REAL) STRICT',
);
const insert = archive.prepare(
  'INSERT INTO metrics (at, cpu, memory, temperature) VALUES (?, ?, ?, ?)',
);
let filledTo = firstMinute - 1;
function fill(until) {
  archive.exec('BEGIN');
  for (let minute = filledTo + 1; minute * MINUTE <= until; minute++, filledTo = minute - 1) {
    const sample = reading(minute * MINUTE);
    if (sample) insert.run(minute * MINUTE, ...sample);
  }
  archive.exec('COMMIT');
}
fill(started - 20_000);

async function publishHistory() {
  const now = Date.now();
  fill(now - 20_000);
  await writeFile(join(directory, 'history.json'), JSON.stringify(queryDashboard(archive, now)));
}

async function update() {
  const at = scenario === 'stale' ? started - 25 * MINUTE : Date.now();
  const hot = scenario === 'hot';
  const cores = [29, 31, 30, 28, 29, 27].map((celsius) => (hot ? celsius + 47 : celsius));
  await writeFile(
    join(directory, 'metrics.json'),
    JSON.stringify({
      schema: 1,
      version: '0.3.0',
      generatedAt: at,
      thermalWarnC: 80,
      thermalRecoverC: 75,
      live: {
        capturedAt: at,
        hostUptime: 10 * 86400 - 1800 + Math.round((Date.now() - started) / 1000),
        botUptime: 5 * 3600 + 14 * 60,
        cpuPercent: hot ? 71.4 : +(1.5 + noise() * 3).toFixed(1),
        cores: 6,
        memory: { total: 8136000000, used: 1002000000, available: 7134000000, percent: 12.3 },
        swap: { total: 4294967296, used: 0, available: 4294967296, percent: 0 },
        load: hot ? [4.12, 3.77, 2.9] : [0.08, 0.11, 0.09],
        temperatures: [
          { label: 'Package id 0', celsius: hot ? 82 : 34 },
          ...cores.map((celsius, i) => ({ label: `Core ${i}`, celsius })),
        ],
      },
      history: null,
    }),
  );
}
await publishHistory();
await update();
const server = await createDashboard(
  loadDashboardConfig({ DASHBOARD_PORT: String(port), PUBLIC_DATA_PATH: directory }),
);
// A same-origin, development-only frame exercises actual mobile media queries.
// The production server keeps frame-ancestors 'none' and has no preview routes.
const [application] = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (request, response) => {
  response.setHeader('X-Optiplex-Preview', 'sample-data');
  if (request.url?.startsWith('/__preview')) {
    const width = new URL(request.url, 'http://localhost').searchParams.get('width');
    const size = ['320', '390', '768'].includes(width) ? width : '390';
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      `<!doctype html><html lang="en"><title>Optiplex responsive preview</title><body style="margin:0;background:#171719;color:#e8e9eb;font:14px system-ui"><p style="text-align:center">LOCAL SAMPLE DATA · <a style="color:#26bcc5" href="/__preview?width=320">320px</a> · <a style="color:#26bcc5" href="/__preview?width=390">390px</a> · <a style="color:#26bcc5" href="/__preview?width=768">768px</a> · <a style="color:#26bcc5" href="/">Desktop</a></p><iframe title="Mobile dashboard" src="/" width="${size}" height="900" style="display:block;margin:auto;border:1px solid #444;height:calc(100vh - 65px)"></iframe></body></html>`,
    );
    return;
  }
  const writeHead = response.writeHead.bind(response);
  response.writeHead = (status, headers) =>
    writeHead(status, {
      ...headers,
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': headers['Content-Security-Policy'].replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'self'",
      ),
    });
  application(request, response);
});
server.listen(port, host, () =>
  console.log(
    `Local: http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (sample data only)`,
  ),
);
const timer = setInterval(() => {
  if (scenario !== 'stale') update().catch(console.error);
}, 30_000);
const historyTimer = setInterval(() => {
  if (scenario !== 'stale') publishHistory().catch(console.error);
}, 300_000);
async function stop() {
  clearInterval(timer);
  clearInterval(historyTimer);
  server.closeAllConnections();
  server.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGTERM', () => {
  stop().catch(console.error);
});
process.once('SIGINT', () => {
  stop().catch(console.error);
});
