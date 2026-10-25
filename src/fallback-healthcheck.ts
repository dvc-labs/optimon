import { request } from 'node:http';
import { loadFallbackConfig } from './fallback-server.js';

try {
  const config = loadFallbackConfig();
  const probe = request(
    { hostname: '127.0.0.1', port: config.port, path: '/healthz', timeout: 3000 },
    (response) => {
      response.resume();
      process.exitCode = response.statusCode === 200 ? 0 : 1;
    },
  );
  probe.once('error', () => {
    process.exitCode = 1;
  });
  probe.once('timeout', () => {
    probe.destroy();
    process.exitCode = 1;
  });
  probe.end();
} catch {
  process.exitCode = 1;
}
