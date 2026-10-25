# Keep the dashboard available when optiplex is off

The public address stays **https://dashboard.davevancauwenberghe.be/**. A small
Cloudflare **Worker Route** tries the existing home origin and serves a matching
VPS page if that origin cannot be reached. The browser is never redirected to the
VPS hostname. The home tunnel, certificates, bot, private archive and volume names
keep their existing settings.

The fallback uses the dashboard's own black/soft-white/turquoise stylesheet,
self-hosted IBM Plex Sans and League Spartan, including the dvc. tracking. It is a
separate non-root, read-only container capped at 64 MiB and 0.25 CPU. It has no
Discord credentials, database, host sensor mounts or persistent volume.

## What the states mean

| Situation | Behaviour |
| --- | --- |
| Home dashboard and monitor are running | The normal dashboard and fresh measurements. |
| The monitor stops but the home web container remains up | Existing values are labelled **Last recorded readings** after three minutes. |
| The home web service, tunnel or machine becomes unreachable | New visitors get the VPS page, with **Unavailable** for current measurements. |
| A normal dashboard was already open during the outage | Current readings/sensors are hidden; previously loaded graphs remain explicitly historical. |
| The home service returns | The fallback checks every 30 seconds while visible and returns to `/` only after a fresh, real sample is available. |

An unreachable service cannot prove the machine was powered off. No zero-valued
samples, pretend temperatures or growing uptime are generated. This first fallback
does not copy the archive: history remains on optiplex and cannot be loaded by a new
visitor while that machine is off. It is not a backup or a second monitoring bot.

## 1. Upgrade the existing home resource

Merge this PR, then deploy the existing Optimon resource on **optiplex** using its
existing `compose.yaml`, branch, credentials and local history volume. This adds
the availability handling and an origin-identification header; there is no schema
migration. Keep the existing home tunnel running.

For `DASHBOARD_PUBLIC_URL=https://dashboard.davevancauwenberghe.be` and
`DASHBOARD_TLS_HOST_PATH=/etc/optiplex-dashboard/tls`, enable **Available at Buildtime**
and **Available at Runtime** in Coolify. Compose evaluates these references while
building as well as while starting the services. This is specific to these two
non-secret settings. Keep the home resource's Domains fields empty and its
loopback-only `127.0.0.1:3443` binding.

## 2. Prepare the VPS hostname

In Cloudflare DNS for `davevancauwenberghe.be`, add:

| Type | Name | Target | Proxy |
| --- | --- | --- | --- |
| A | `dashboard-fallback` | `157.173.101.60` | Proxied (orange cloud) |

Keep the existing **dashboard CNAME pointing to the home tunnel UUID**. Do not add
another A/CNAME for `dashboard`, change the home IP or duplicate its tunnel token
on the VPS. The fallback hostname is the Worker's backend address.

## 3. Deploy the separate fallback resource on the VPS

In Coolify, create a **new Docker Compose application on the VPS**, using:

| Setting | Value |
| --- | --- |
| Repository | `https://github.com/dvc-labs/optimon` |
| Branch | `main` |
| Base directory | `/` |
| Compose location | `/compose.fallback.yaml` |
| Service | `fallback` |
| Internal HTTP port | `8080` |
| Public domain | `https://dashboard-fallback.davevancauwenberghe.be` |

If Coolify uses one domain field to specify the internal port, enter
`https://dashboard-fallback.davevancauwenberghe.be:8080`. The browser still uses
standard HTTPS on 443; the suffix tells Coolify's proxy which container port to use.

Add **only** `DASHBOARD_PUBLIC_URL=https://dashboard.davevancauwenberghe.be`, with both
build-time and runtime availability enabled, then deploy. The Compose file selects
the `fallback` Docker target automatically. Do not copy bot secrets or attach its
archive volume. No new publicly published 8080 port or home firewall rule is needed.

Use Coolify's existing VPS HTTPS proxy and a valid certificate, as for your other
VPS applications. Keep Cloudflare SSL verification enabled with Full (strict).
Ensure any hostname-specific rules permit the Worker to fetch the fallback site;
an interactive browser challenge cannot be used on this backend hostname. Avoid
changing protections for unrelated sites.

Check from your Mac/PC:

```bash
curl --fail --silent --show-error --head \
  https://dashboard-fallback.davevancauwenberghe.be/
curl --fail --silent --show-error \
  https://dashboard-fallback.davevancauwenberghe.be/healthz
```

Expect HTTP 200, `X-Optimon-Origin: fallback`, and
`{"ok":true,"mode":"fallback"}`. `/api/live` intentionally returns **503 JSON with
`data: null`** on this backend. Its health endpoint checks the fallback web process,
not the home host. Direct visits to the backend remain on the offline page; recovery
is meant to run under the primary dashboard address after the next step.

## 4. Deploy the Cloudflare Worker

The Worker is plain JavaScript with no npm dependencies or runtime secrets. It
needs a **Route**, not a Worker Custom Domain: a Route keeps the existing tunnel
CNAME as the home origin. All URLs below are public configuration values.

From a local checkout on a Mac/PC with Node.js 24, authenticate to the Cloudflare
account that owns the zone and deploy the supplied configuration:

```bash
git clone https://github.com/dvc-labs/optimon.git
cd optimon
npx --yes wrangler@4.152.0 login
npx --yes wrangler@4.152.0 deploy --config deploy/wrangler.jsonc
```

If you already have a checkout, update and use that directory. This Worker deploy
does not require installing the bot's dependencies or entering its Discord token.
Wrangler opens the browser for account authentication.

`deploy/wrangler.jsonc` configures:

| Setting | Value |
| --- | --- |
| Worker name | `optimon-dashboard-failover` |
| Route pattern | `dashboard.davevancauwenberghe.be/*` |
| Zone | `davevancauwenberghe.be` |
| `DASHBOARD_PUBLIC_URL` | `https://dashboard.davevancauwenberghe.be` |
| `FALLBACK_ORIGIN` | `https://dashboard-fallback.davevancauwenberghe.be` |
| `ORIGIN_TIMEOUT_MS` | `2500` |

The public `workers.dev` and preview URLs are disabled. If using the Cloudflare
dashboard instead, create the Worker from `deploy/worker.mjs`, set the three
variables, then add the route under **Settings → Domains & Routes → Add → Route**.
Check that no broader Worker route is also assigned to the fallback hostname.

The primary deadline covers response headers and body; failure tries the VPS with
a separate 2.5-second deadline. A real home-app 503 waiting for its first data export
stays on the home dashboard. Other origin 5xx/network errors use the fallback.
Normal 404/429 responses pass through. Fallback-specific assets always come from
the VPS, including while the home server is recovering.

The Worker accepts public GET/HEAD routes only, does not follow upstream redirects,
strips visitor cookies/Authorization from upstream requests and removes Set-Cookie
from responses. Fallback documents and metric responses use `Cache-Control: no-store`;
content-hashed fonts/styles/scripts can still be cached. A wrong VPS app/challenge
page is refused. If both origins fail, a bounded generic 503 is returned without
diagnostic details. Availability still depends on the Worker and VPS being reachable.

## 5. Test an outage and recovery

First verify the primary URL is live:

```bash
curl --fail --silent --show-error \
  https://dashboard.davevancauwenberghe.be/api/live
```

Expect `status.state: "live"`. Then, on **optiplex**, briefly stop only its connector:

```bash
sudo systemctl stop optiplex-dashboard-tunnel.service
```

Open the primary dashboard in a **new tab**. It should show the branded unavailable
page at the same address. In a tab that already had the normal dashboard open, the
next poll hides current measurements and marks the remaining graphs as historical.

```bash
curl --fail --silent --show-error --head \
  https://dashboard.davevancauwenberghe.be/
curl --silent --show-error --include \
  https://dashboard.davevancauwenberghe.be/api/live
```

The page returns HTTP 200 with `X-Optimon-Fallback: 1`; the API returns HTTP 503,
an unavailable status and `data: null`. Neither response invents a sensor reading.

Start the connector again on **optiplex**:

```bash
sudo systemctl start optiplex-dashboard-tunnel.service
```

When a fresh sample is available, the fallback returns to the normal dashboard on
its next 30-second check, or immediately after **Check again**. An already-open
normal dashboard resumes through its normal polling. Background tabs pause checks
and check again when visible. No history is deleted by this test.

## Maintenance and rollback

- Keep the VPS fallback's Git source up to date alongside the home resource so its
  shared fonts/styles/scripts remain compatible. Rebuild to pick up Node image fixes.
- The fallback has no data volume to back up. Keep backing up the real archive.
- `/healthz` measures web-process health; use `/api/live` and its freshness state
  when checking whether home monitoring is available. The existing external bot
  heartbeat remains useful and independent of this page.
- To undo failover, remove only the `dashboard.davevancauwenberghe.be/*` Worker route.
  The existing CNAME then continues directly to the original home tunnel. The VPS
  fallback resource and its dedicated DNS record can be removed afterwards.

## References

- [Worker Routes and forwarding to the DNS-defined origin](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Handling origin fetch errors](https://developers.cloudflare.com/workers/observability/errors/)
- [Coolify Docker Compose applications](https://coolify.io/docs/applications/builds/docker-compose)
- [Coolify environment variable scopes](https://coolify.io/docs/applications/configuration/environment-variables)
