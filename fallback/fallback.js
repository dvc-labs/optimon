import { hasFreshReading, isFallbackResponse } from '/assets/availability.js?v=__ASSET_VERSION__';

const retry = document.getElementById('retry');
const note = document.getElementById('retry-status');
let timer = 0;
let inflight = null;
let generation = 0;
retry.hidden = false;
document.getElementById('refresh').hidden = true;
note.textContent = 'Checking automatically every 30 seconds.';

async function check() {
  if (inflight || document.hidden) return;
  clearTimeout(timer);
  const current = generation;
  const controller = new AbortController();
  inflight = controller;
  const deadline = setTimeout(() => controller.abort(), 8000);
  retry.disabled = true;
  retry.textContent = 'Checking…';
  try {
    const response = await fetch('/api/live', {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    const payload = response.ok && !isFallbackResponse(response) ? await response.json() : null;
    if (current !== generation || controller.signal.aborted) return;
    if (hasFreshReading(payload)) {
      note.textContent = 'Fresh readings are back. Opening the dashboard…';
      // Fixed same-origin destination: never navigate to a server-provided URL or the VPS hostname.
      window.location.replace('/');
      return;
    }
    note.textContent = 'No fresh readings yet. Checking again in 30 seconds.';
  } catch {
    if (current === generation && !document.hidden)
      note.textContent = 'The connection is still unavailable. Checking again in 30 seconds.';
  } finally {
    clearTimeout(deadline);
    if (inflight === controller) {
      inflight = null;
      retry.disabled = false;
      retry.innerHTML = 'Check again <span aria-hidden="true">↗</span>';
    }
    if (current === generation && !document.hidden) timer = setTimeout(check, 30_000);
  }
}
const runCheck = () =>
  check().catch(() => {
    note.textContent = 'The connection is unavailable. You can try again.';
  });
retry.addEventListener('click', runCheck);
document.addEventListener('visibilitychange', () => {
  generation++;
  clearTimeout(timer);
  inflight?.abort();
  inflight = null;
  if (!document.hidden) runCheck();
});
window.addEventListener('online', runCheck);
timer = setTimeout(check, 30_000);

const dialog = document.getElementById('privacy-dialog');
const privacy = document.getElementById('privacy-open');
privacy.hidden = false;
privacy.addEventListener('click', () => dialog.showModal());
document.getElementById('privacy-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
