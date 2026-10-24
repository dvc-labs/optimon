import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadDashboardConfig } from './dashboard-config.js';
import { createDashboard } from './dashboard-server.js';

try {
  const config = loadDashboardConfig();
  const server = await createDashboard(config);
  server.on('error', () => {
    console.error('dashboard_server_failed');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () =>
    console.log(
      `Dashboard listening on ${config.tls ? 'https' : 'http'}://${config.host}:${config.port}`,
    ),
  );
  if (config.tls) {
    // Origin CA certificates are not renewed for you, and the expiry is otherwise invisible
    // until the public site starts returning 502. Say so in the log at every start.
    try {
      const expires = new X509Certificate(readFileSync(config.tls.cert)).validToDate;
      const days = Math.floor((expires.getTime() - Date.now()) / 86_400_000);
      console.log(`tls_certificate_expires ${expires.toISOString().slice(0, 10)} (${days} days)`);
      if (days < 30)
        console.warn('tls_certificate_expiring: replace it, then restart the dashboard');
    } catch {
      /* The server already accepted the certificate; this check is informational. */
    }
  }
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    server.close(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch {
  console.error('dashboard_initialization_failed');
  process.exitCode = 1;
}
