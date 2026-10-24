const $ = (id) => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const names = { cpu: 'CPU', memory: 'Memory', temperature: 'Temperature' };
const number = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});
const integer = new Intl.NumberFormat();
const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const timeOnly = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
let latest = null;
let selectedWindow = '24h';
let selectedMetric = 'cpu';
let hovered = -1;
let chartWindow = null;
let chartScale = null;
let timer = null;
let pending = false;
let controller = null;
let lastResponseAt = 0;
let demo = false;
const text = (id, value) => {
  $(id).textContent = value;
};
const decimal = (value) => (value === null || value === undefined ? '—' : number.format(value));
const unit = () => (selectedMetric === 'temperature' ? ' °C' : '%');
const gib = (value) => (value / 1024 ** 3).toFixed(2);
function duration(seconds) {
  if (seconds === null) return '—';
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : `${hours}h ${minutes % 60}m`;
}
function node(tag, attributes = {}, content) {
  const element = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (content !== undefined) element.textContent = content;
  return element;
}
function state(kind, message) {
  $('status-badge').dataset.state = kind;
  text('status-text', message);
}
function notice(message, isDemo = false) {
  $('notice').hidden = !message;
  $('notice').dataset.demo = String(isDemo);
  text('notice', message);
}
function renderStatus() {
  if (!latest) {
    state('unavailable', 'Readings unavailable');
    return;
  }
  const age = Date.now() - latest.live.capturedAt;
  if (age < -5000 || age > 180_000 || Date.now() - lastResponseAt > 90_000) {
    state('stale', 'Readings are stale');
    notice(
      'These are the last recorded readings. The monitor or connection may be offline; this page cannot determine the cause.',
    );
  } else {
    state('live', 'Fresh host readings');
    notice(
      demo
        ? 'LOCAL PREVIEW · Illustrative sample data. This is not connected to the real home lab.'
        : '',
      demo,
    );
  }
  text('last-updated', timeOnly.format(new Date(latest.live.capturedAt)));
  $('last-updated').dateTime = new Date(latest.live.capturedAt).toISOString();
}
function renderLive() {
  const live = latest.live;
  text('cpu-value', decimal(live.cpuPercent));
  text('cpu-cores', live.cores ?? '—');
  $('cpu-bar').value = live.cpuPercent ?? 0;
  $('memory-bar').value = live.memory?.percent ?? 0;
  text('memory-value', live.memory ? gib(live.memory.used) : '—');
  text('memory-percent', live.memory ? `${decimal(live.memory.percent)}%` : '—');
  text('memory-total', live.memory ? `${gib(live.memory.total)} GiB total` : 'Unavailable');
  text('memory-available', live.memory ? `${gib(live.memory.available)} GiB` : 'Unavailable');
  text(
    'swap-usage',
    live.swap ? `${gib(live.swap.used)} / ${gib(live.swap.total)} GiB` : 'Unavailable',
  );
  $('swap-bar').value = live.swap?.percent ?? 0;
  const hottest = live.temperatures.length
    ? Math.max(...live.temperatures.map((t) => t.celsius))
    : null;
  text('temp-value', decimal(hottest));
  $('temp-bar').value = hottest ?? 0;
  const thermal = $('thermal-state');
  thermal.replaceChildren(
    document.createTextNode(
      hottest === null
        ? 'Unavailable'
        : hottest >= latest.thermalWarnC
          ? 'Above warning threshold'
          : hottest > latest.thermalRecoverC
            ? 'Warm'
            : 'Keeping cool',
    ),
  );
  const threshold = document.createElement('span');
  threshold.className = 'detail-end';
  threshold.textContent = `${latest.thermalWarnC} °C warning`;
  thermal.append(threshold);
  text('uptime-value', duration(live.hostUptime));
  text('bot-uptime', duration(live.botUptime));
  [1, 5, 15].forEach((period, i) =>
    text(`load-${period}`, live.load ? live.load[i].toFixed(2) : '—'),
  );
  const sensors = $('temperature-list');
  sensors.replaceChildren();
  for (const reading of live.temperatures) {
    const item = document.createElement('div');
    item.className = `sensor${reading.label.startsWith('Package') ? ' sensor-package' : ''}`;
    item.dataset.hot = String(reading.celsius >= latest.thermalWarnC);
    const label = document.createElement('span');
    label.textContent = reading.label.replace('Package id ', 'CPU package ');
    const value = document.createElement('strong');
    value.textContent = `${decimal(reading.celsius)} `;
    const suffix = document.createElement('small');
    suffix.textContent = '°C';
    value.append(suffix);
    item.append(label, value);
    sensors.append(item);
  }
  if (!live.temperatures.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No readable temperature sensors.';
    sensors.append(empty);
  }
  text('version', `v${latest.version}`);
  text('archive-total', latest.history ? integer.format(latest.history.totalSamples) : '—');
  text(
    'archive-first',
    latest.history?.firstAt !== null && latest.history?.firstAt !== undefined
      ? `Since ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(latest.history.firstAt))}`
      : 'Waiting for the archive.',
  );
}
function selectPoint(index) {
  if (!chartWindow || !chartScale) return;
  hovered = Math.max(0, Math.min(chartWindow.points.length - 1, index));
  const point = chartWindow.points[hovered];
  const value = point[selectedMetric];
  const crosshair = $('chart-crosshair');
  const x = chartScale.x(hovered);
  crosshair.setAttribute('x1', x);
  crosshair.setAttribute('x2', x);
  crosshair.setAttribute('visibility', 'visible');
  text(
    'chart-tooltip',
    `${dateTime.format(new Date(point.at))} · ${value === null ? 'No reading' : `${decimal(value)}${unit()}`}`,
  );
  $('chart-tooltip').hidden = false;
}
function clearHover() {
  hovered = -1;
  $('chart-tooltip').hidden = true;
  $('chart-crosshair')?.setAttribute('visibility', 'hidden');
}
function renderChart() {
  const chart = $('history-chart');
  clearHover();
  chartWindow = latest?.history?.windows.find((w) => w.key === selectedWindow) ?? null;
  const title = node(
    'title',
    { id: 'chart-title' },
    `${names[selectedMetric]} history · ${selectedWindow === 'all' ? 'all recorded time' : selectedWindow}`,
  );
  const description = node(
    'desc',
    { id: 'chart-description' },
    'Average per time bucket. Empty buckets are gaps. Use left and right arrow keys for readings, or open View chart data for a table.',
  );
  chart.replaceChildren(title, description);
  const left = 52,
    right = 1080,
    top = 15,
    bottom = 260;
  let maximum = 100,
    minimum = 0;
  const readings =
    chartWindow?.points.map((p) => p[selectedMetric]).filter((v) => v !== null) ?? [];
  if (selectedMetric === 'temperature') {
    minimum = Math.floor(Math.min(20, ...readings) / 10) * 10;
    maximum = Math.ceil(Math.max(50, ...readings) / 10) * 10;
  }
  const y = (v) => bottom - ((v - minimum) / (maximum - minimum)) * (bottom - top);
  const x = (i) => left + (i / 95) * (right - left);
  chartScale = { x, y };
  for (let i = 0; i <= 4; i++) {
    const value = minimum + ((maximum - minimum) * i) / 4;
    chart.append(
      node('line', {
        x1: left,
        x2: right,
        y1: y(value),
        y2: y(value),
        stroke: '#252529',
        'stroke-width': 1,
        'stroke-dasharray': '3 5',
      }),
      node(
        'text',
        {
          x: left - 12,
          y: y(value) + 4,
          fill: '#92949e',
          'font-size': 11,
          'font-family': 'ui-monospace, monospace',
          'text-anchor': 'end',
        },
        `${Math.round(value)}${selectedMetric === 'temperature' ? '°' : '%'}`,
      ),
    );
  }
  const defs = node('defs');
  const gradient = node('linearGradient', {
    id: 'area-gradient',
    x1: '0',
    y1: '0',
    x2: '0',
    y2: '1',
  });
  gradient.append(
    node('stop', { offset: '0%', 'stop-color': '#26bcc5', 'stop-opacity': '.20' }),
    node('stop', { offset: '100%', 'stop-color': '#26bcc5', 'stop-opacity': '0' }),
  );
  defs.append(gradient);
  chart.append(defs);
  let segment = [];
  function drawSegment() {
    if (!segment.length) return;
    const line = segment
      .map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`)
      .join(' ');
    chart.append(
      node('path', {
        d: `${line} L${segment.at(-1)[0]},${bottom} L${segment[0][0]},${bottom} Z`,
        fill: 'url(#area-gradient)',
      }),
    );
    chart.append(
      node('path', {
        d: line,
        fill: 'none',
        stroke: '#26bcc5',
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        'vector-effect': 'non-scaling-stroke',
      }),
    );
    if (segment.length === 1)
      chart.append(node('circle', { cx: segment[0][0], cy: segment[0][1], r: 3, fill: '#26bcc5' }));
    segment = [];
  }
  chartWindow?.points.forEach((p, i) => {
    const value = p[selectedMetric];
    if (value === null) drawSegment();
    else segment.push([x(i), y(value)]);
  });
  drawSegment();
  chart.append(
    node('line', {
      id: 'chart-crosshair',
      x1: left,
      x2: left,
      y1: top,
      y2: bottom,
      stroke: '#729499',
      'stroke-dasharray': '4 4',
      'stroke-width': 1,
      visibility: 'hidden',
    }),
  );
  $('chart-empty').hidden = readings.length > 0;
  text(
    'chart-empty',
    !chartWindow
      ? 'Waiting for the first archive export…'
      : `No ${names[selectedMetric].toLowerCase()} readings in this period.`,
  );
  const summary = chartWindow?.[selectedMetric];
  ['mean', 'min', 'max'].forEach((key) =>
    text(`history-${key}`, summary ? `${decimal(summary[key])}${unit()}` : '—'),
  );
  text('history-count', summary ? integer.format(summary.count) : '0');
  text('range-start', chartWindow ? dateTime.format(new Date(chartWindow.from)) : '—');
  text('range-end', chartWindow ? dateTime.format(new Date(chartWindow.to - 1)) : '—');
  const expected = chartWindow ? Math.max(1, (chartWindow.to - chartWindow.from) / 60_000) : 0;
  text(
    'coverage-note',
    chartWindow
      ? `${integer.format(chartWindow.count)} samples · ${Math.min(100, (chartWindow.count / expected) * 100).toFixed(1)}% of a 1/min cadence · gaps stay empty`
      : 'Metrics are sampled once a minute. Empty periods stay empty.',
  );
  const age = latest?.history ? Date.now() - latest.history.generatedAt : Infinity;
  text(
    'history-updated',
    age > 600_000 && Number.isFinite(age)
      ? `Archive export stale · ${Math.floor(age / 60_000)} min old`
      : 'Archive updates every 5 min',
  );
  text(
    'data-caption',
    `${names[selectedMetric]} selected · ${selectedWindow} · all values are bucket averages`,
  );
  const body = $('chart-data');
  body.replaceChildren();
  for (const point of chartWindow?.points ?? []) {
    const row = document.createElement('tr');
    [
      dateTime.format(new Date(point.at)),
      `${decimal(point.cpu)}${point.cpu === null ? '' : '%'}`,
      `${decimal(point.memory)}${point.memory === null ? '' : '%'}`,
      `${decimal(point.temperature)}${point.temperature === null ? '' : ' °C'}`,
    ].forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    });
    body.append(row);
  }
}
for (const button of document.querySelectorAll('[data-window]'))
  button.addEventListener('click', () => {
    selectedWindow = button.dataset.window;
    for (const b of document.querySelectorAll('[data-window]'))
      b.setAttribute('aria-pressed', String(b === button));
    renderChart();
  });
for (const button of document.querySelectorAll('[data-metric]'))
  button.addEventListener('click', () => {
    selectedMetric = button.dataset.metric;
    for (const b of document.querySelectorAll('[data-metric]'))
      b.setAttribute('aria-pressed', String(b === button));
    renderChart();
  });
$('history-chart').addEventListener('pointermove', (event) => {
  const rect = $('history-chart').getBoundingClientRect();
  const location = ((event.clientX - rect.left) / rect.width) * 1100;
  selectPoint(Math.round(((location - 52) / (1080 - 52)) * 95));
});
$('history-chart').addEventListener('pointerleave', clearHover);
$('history-chart').addEventListener('blur', clearHover);
$('history-chart').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault();
    selectPoint((hovered < 0 ? 0 : hovered) + (event.key === 'ArrowRight' ? 1 : -1));
  } else if (event.key === 'Escape') clearHover();
});
$('privacy-open').addEventListener('click', () => $('privacy-dialog').showModal());
$('privacy-close').addEventListener('click', () => $('privacy-dialog').close());
for (const link of document.querySelectorAll('nav a'))
  link.addEventListener('click', () => {
    for (const a of document.querySelectorAll('nav a'))
      a.classList.toggle('nav-active', a === link);
  });
async function poll() {
  if (pending || document.hidden) return;
  pending = true;
  controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/metrics', {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Readings unavailable');
    const payload = await response.json();
    if (!payload.data || payload.data.schema !== 1) throw new Error('Unsupported data');
    latest = payload.data;
    lastResponseAt = Date.now();
    demo = response.headers.get('X-Optiplex-Preview') === 'sample-data';
    renderLive();
    renderChart();
    renderStatus();
  } catch {
    if (latest) {
      state('stale', 'Connection interrupted');
      notice(
        'The latest update could not be loaded. Values shown are the last recorded readings; the page will retry automatically.',
      );
    } else {
      state('unavailable', 'Readings unavailable');
      notice(
        'The monitor has not published readable metrics yet, or the connection is unavailable. The page will retry automatically.',
      );
    }
  } finally {
    clearTimeout(deadline);
    pending = false;
    controller = null;
  }
}
function schedule() {
  clearInterval(timer);
  if (!document.hidden) {
    poll().catch(() => {});
    timer = setInterval(() => {
      renderStatus();
      poll().catch(() => {});
    }, 30_000);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(timer);
    controller?.abort();
  } else schedule();
});
renderChart();
schedule();
