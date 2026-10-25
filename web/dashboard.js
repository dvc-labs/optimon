import {
  HOUR,
  SAMPLE_MS,
  WINDOWS,
  availableWindows,
  coverageSentence,
  defaultWindow,
  describeMachine,
  formatSpan,
  freshness,
  hottestReading,
  nearestIndex,
  runsAndGaps,
  sensorName,
  summarySentence,
  timeTicks,
  valueScale,
} from './chart-model.js?v=__ASSET_VERSION__';
import { isFallbackResponse } from './availability.js?v=__ASSET_VERSION__';

const POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const NBSP = ' ';
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const one = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const loose = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const monthOnly = new Intl.DateTimeFormat(undefined, { month: 'short' });
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const stamp = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const shortStamp = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const METRICS = {
  cpu: {
    name: 'CPU',
    format: (v) => `${one.format(v)}%`,
    tick: (v) => `${v}%`,
  },
  memory: {
    name: 'Memory',
    format: (v) => `${one.format(v)}%`,
    tick: (v) => `${v}%`,
  },
  temperature: {
    name: 'Temperature',
    format: (v) => `${loose.format(v)}${NBSP}°C`,
    tick: (v) => `${v}${NBSP}°C`,
  },
};

const gib = (bytes) => bytes / 1024 ** 3;
const setText = (id, value) => {
  $(id).textContent = value;
};

/** Show a reading, or an en dash (with its unit hidden) when the machine did not report one. */
function setValue(id, value) {
  const empty = value === null || value === undefined;
  setText(id, empty ? '–' : value);
  $(id).parentElement.toggleAttribute('data-empty', empty);
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

let live = null; // { data, status, receivedAt, preview }
let history = null;
let failures = 0;
let windowKey = null;
let metric = 'cpu';
let selectedAt = null; // survives a history refresh, so the tooltip does not jump
let view = null; // geometry of the chart as last drawn
let lastState = null;
let requestId = 0;
let inflight = null;
let generation = 0;
let pollTimer = 0;
let originUnavailable = false;

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

function setState(state, message) {
  document.body.dataset.state = state;
  // Only a change between fresh and out-of-date is worth interrupting a screen reader for.
  const states = ['live', 'stale', 'offline'];
  const flipped = states.includes(lastState) && state !== lastState;
  if (flipped && states.includes(state) && message) setText('announce', message);
  lastState = state;
}

function setNotice(message, demo = false) {
  const element = $('notice');
  element.hidden = !message;
  element.dataset.demo = String(demo);
  element.textContent = message ?? '';
}

function renderStatus() {
  $('current-readings').hidden = originUnavailable;
  $('temperature-readings').hidden = originUnavailable;
  $('offline-readings').hidden = !originUnavailable;
  if (originUnavailable) {
    setState('offline', 'The home server is unreachable.');
    setText('verdict', 'optiplex is currently unreachable.');
    setText(
      'detail',
      'The machine, the monitor or its connection may be unavailable. This page will reconnect automatically.',
    );
    setNotice(
      live ? 'Any remaining readings and graphs are from before the connection was lost.' : null,
    );
    return;
  }
  if (!live) {
    setState('unavailable');
    setText('verdict', failures ? 'No readings yet.' : 'optimon');
    setText(
      'detail',
      failures
        ? "The monitor hasn't published anything this page can read, or the connection is down. It will keep trying."
        : 'Loading the latest reading.',
    );
    setNotice(null);
    return;
  }
  const f = freshness(live.status, live.receivedAt, performance.now());
  $('reading-age').hidden = f.state !== 'stale';
  if (f.state === 'stale')
    setText(
      'reading-age',
      `Last recorded readings, received ${describeAge(f.age)}. These are not current measurements.`,
    );
  if (f.state === 'stale') {
    setState('stale', 'These readings are out of date.');
    setText('verdict', 'No fresh readings.');
    setText(
      'detail',
      `The last one arrived ${describeAge(f.age)}. The machine, the monitor or the connection may be down; this page can't tell which.`,
    );
  } else {
    setState('live', 'Readings are current again.');
    const { verdict, detail } = describeMachine(live.data, f.age);
    setText('verdict', verdict);
    setText('detail', detail);
  }
  if (failures >= 2 || !f.connected)
    setNotice(
      "The latest update couldn't be loaded. These are the last readings received; the page keeps trying.",
    );
  else if (live.preview)
    setNotice('Local preview with made-up sample data. This is not the real machine.', true);
  else setNotice(null);
}

// ---------------------------------------------------------------------------------------------
// Current readings
// ---------------------------------------------------------------------------------------------

function renderLive() {
  const { data } = live;
  const now = data.live;
  const reading = hottestReading(data);

  setValue('cpu-value', now.cpuPercent === null ? null : one.format(now.cpuPercent));
  $('cpu-bar').value = now.cpuPercent ?? 0;
  setText('cpu-context', now.cores ? `${now.cores} cores` : '');

  const memory = now.memory;
  setValue('memory-value', memory ? one.format(gib(memory.used)) : null);
  $('memory-bar').value = memory?.percent ?? 0;
  setText(
    'memory-context',
    memory
      ? `${loose.format(memory.percent)}% of ${one.format(gib(memory.total))} GiB, ${one.format(gib(memory.available))} GiB available`
      : 'Not reported.',
  );

  setValue('temp-value', reading ? loose.format(reading.celsius) : null);
  $('temp-bar').value = reading ? Math.min(100, (reading.celsius / data.thermalWarnC) * 100) : 0;
  $('row-temperature').dataset.state =
    reading && reading.celsius >= data.thermalWarnC ? 'hot' : 'ok';
  setText(
    'temp-context',
    reading
      ? `${sensorName(reading.label)}. Warning level ${data.thermalWarnC}${NBSP}°C.`
      : 'No readable sensors.',
  );

  const load = now.load;
  setValue('load-value', load ? load[0].toFixed(2) : null);
  setText(
    'load-context',
    load
      ? `Averages over 1, 5 and 15 minutes: ${load.map((v) => v.toFixed(2)).join(', ')}${now.cores ? `, on ${now.cores} cores` : ''}.`
      : 'Not reported.',
  );

  const swap = now.swap;
  setValue('swap-value', swap ? one.format(gib(swap.used)) : null);
  $('swap-bar').value = swap?.percent ?? 0;
  setText(
    'swap-context',
    !swap
      ? 'Not reported.'
      : swap.total === 0
        ? 'No swap space is set up.'
        : `${loose.format(swap.percent)}% of ${one.format(gib(swap.total))} GiB`,
  );

  const rows = [...now.temperatures].sort(
    (a, b) =>
      Number(b.label.startsWith('Package')) - Number(a.label.startsWith('Package')) ||
      a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
  const body = $('sensor-rows');
  body.replaceChildren();
  for (const sensor of rows) {
    const row = document.createElement('tr');
    if (sensor.label.startsWith('Package')) row.dataset.package = '';
    row.dataset.hot = String(sensor.celsius >= data.thermalWarnC);
    const label = document.createElement('td');
    label.textContent = sensorName(sensor.label);
    const value = document.createElement('td');
    value.textContent = `${loose.format(sensor.celsius)}${NBSP}°C`;
    row.append(label, value);
    body.append(row);
  }
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 2;
    cell.textContent = 'No readable temperature sensors.';
    row.append(cell);
    body.append(row);
  }
  setText('sensor-note', `Counted as cool again at ${data.thermalRecoverC}${NBSP}°C or below.`);

  setText(
    'monitor-note',
    `Host uptime: ${now.hostUptime === null ? 'not reported' : formatSpan(now.hostUptime * 1000)}. Monitor uptime: ${formatSpan(now.botUptime * 1000)}. Readings every minute.`,
  );
  renderArchiveNote();
}

function renderArchiveNote() {
  if (!live) return;
  setText(
    'version',
    history?.firstAt != null
      ? `optimon v${live.data.version}. ${whole.format(history.totalSamples)} readings since ${dateOnly.format(new Date(history.firstAt))}.`
      : `optimon v${live.data.version}`,
  );
}

// ---------------------------------------------------------------------------------------------
// History chart
// ---------------------------------------------------------------------------------------------

function currentWindow() {
  return history && windowKey ? (history.windows.find((w) => w.key === windowKey) ?? null) : null;
}

function renderTrends() {
  const key = availableWindows(history).includes('1h') ? '1h' : 'all';
  const window = history?.windows.find((w) => w.key === key) ?? null;
  const period = key === '1h' ? 'Last hour' : 'All recorded history';
  setText(
    'trends-period',
    window ? `${period} ending ${clock.format(window.to - 1)}` : 'Waiting for history',
  );
  for (const metric of ['cpu', 'memory', 'temperature']) {
    const spec = METRICS[metric];
    const chart = $(`trend-${metric}`);
    const aggregate = window?.[metric] ?? null;
    const points = window?.points ?? [];
    const values = points.map((point) => point[metric]).filter((value) => value !== null);
    const scale = valueScale(metric, values, live?.data.thermalWarnC ?? null);
    chart.replaceChildren();
    setText(`trend-${metric}-average`, aggregate ? spec.format(aggregate.mean) : '–');
    setText(
      `trend-${metric}-note`,
      aggregate
        ? `Scale ${spec.tick(scale.min)}–${spec.tick(scale.max)} · peak ${spec.format(aggregate.max)}`
        : 'No recorded readings yet.',
    );
    chart.setAttribute(
      'aria-label',
      aggregate
        ? `${spec.name}, ${period.toLowerCase()}: average ${spec.format(aggregate.mean)}, peak ${spec.format(aggregate.max)}. Gaps mean no readings.`
        : `${spec.name} trend: no readings available.`,
    );
    for (const y of [10, 48, 86])
      chart.append(svg('line', { x1: 4, x2: 316, y1: y, y2: y, class: 'trend-grid-line' }));
    if (!window || !aggregate || window.to <= window.from) {
      chart.append(
        svg(
          'text',
          { x: 160, y: 52, 'text-anchor': 'middle', class: 'trend-empty' },
          'No readings',
        ),
      );
      continue;
    }
    const x = (at) => 4 + ((at - window.from) / (window.to - window.from)) * 312;
    const y = (value) => 86 - ((value - scale.min) / (scale.max - scale.min)) * 76;
    for (const run of runsAndGaps(points, metric, window.from, window.to).runs) {
      if (run.length === 1)
        chart.append(
          svg('circle', { cx: x(run[0].at), cy: y(run[0].value), r: 2.5, class: 'trend-dot' }),
        );
      else
        chart.append(
          svg('path', {
            d: run
              .map(
                (point, i) =>
                  `${i ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(point.value).toFixed(1)}`,
              )
              .join(''),
            class: 'trend-series',
          }),
        );
    }
  }
}

function svg(tag, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function tickLabel(at, unit, span) {
  const date = new Date(at);
  if (unit === 'M') return date.getMonth() === 0 ? monthYear.format(date) : monthOnly.format(date);
  if (unit === 'd') return dayMonth.format(date);
  const midnight = date.getHours() === 0 && date.getMinutes() === 0;
  return midnight && span > 12 * HOUR ? dayMonth.format(date) : clock.format(date);
}

function renderChart() {
  const box = $('chart');
  const canvas = $('chart-svg');
  const keep = selectedAt;
  clearSelection();
  selectedAt = keep;
  canvas.replaceChildren();
  view = null;
  const w = currentWindow();
  const width = Math.round(box.clientWidth);
  const height = Math.round(box.clientHeight);
  const empty = $('chart-empty');
  if (width < 80 || height < 80) return;
  canvas.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const spec = METRICS[metric];
  if (!w || !(w.to > w.from)) {
    empty.hidden = false;
    empty.textContent = history
      ? 'Nothing recorded for this period yet.'
      : 'Waiting for the first history export.';
    return;
  }

  const values = w.points.map((p) => p[metric]).filter((v) => v !== null && v !== undefined);
  const scale = valueScale(metric, values, live?.data.thermalWarnC ?? null);
  const labels = scale.ticks.map((t) => spec.tick(t));
  const left = Math.ceil(Math.max(...labels.map((l) => l.length)) * 7.4) + 14;
  const right = width - 10;
  const top = 14;
  const bottom = height - 30;
  const x = (t) => left + ((t - w.from) / (w.to - w.from)) * (right - left);
  const y = (v) => bottom - ((v - scale.min) / (scale.max - scale.min)) * (bottom - top);
  const span = w.to - w.from;

  const { runs, gaps } = runsAndGaps(w.points, metric, w.from, w.to);
  const drawn = runs.flat().map((p) => ({ at: p.at, value: p.value, x: x(p.at), y: y(p.value) }));
  empty.hidden = drawn.length > 0;
  if (!drawn.length) empty.textContent = `No ${spec.name.toLowerCase()} readings in this period.`;

  const defs = svg('defs');
  const hatch = svg('pattern', {
    id: 'gap-hatch',
    width: 7,
    height: 7,
    patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)',
  });
  hatch.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-line' }));
  defs.append(hatch);
  canvas.append(defs);

  scale.ticks.forEach((tick, i) => {
    canvas.append(
      svg('line', { x1: left, x2: right, y1: y(tick), y2: y(tick), class: i ? 'grid' : 'axis' }),
      svg(
        'text',
        { x: left - 8, y: y(tick) + 4, 'text-anchor': 'end', class: 'tick-label' },
        labels[i],
      ),
    );
  });

  const maxTicks = Math.max(2, Math.min(7, Math.floor((right - left) / 96)));
  const time = timeTicks(w.from, w.to, maxTicks);
  for (const tick of time.ticks) {
    const px = x(tick);
    const anchor = px < left + 22 ? 'start' : px > right - 22 ? 'end' : 'middle';
    canvas.append(
      svg('line', { x1: px, x2: px, y1: bottom, y2: bottom + 5, class: 'axis' }),
      svg(
        'text',
        { x: px, y: bottom + 21, 'text-anchor': anchor, class: 'tick-label' },
        tickLabel(tick, time.unit, span),
      ),
    );
  }

  // Stretches with no readings are hatched. Time before the archive began is not an outage.
  const earliest = history?.firstAt ?? w.from;
  const visibleGaps = [];
  for (const gap of gaps) {
    const from = Math.max(gap.from, earliest);
    if (gap.to - from <= 2.5 * SAMPLE_MS) continue;
    const x0 = Math.max(left, x(from));
    const x1 = Math.min(right, x(gap.to));
    visibleGaps.push({ from, to: gap.to, x0, x1 });
    canvas.append(
      svg('rect', { x: x0, y: top, width: x1 - x0, height: bottom - top, fill: 'url(#gap-hatch)' }),
    );
    if (x1 - x0 >= 120) {
      const mid = (x0 + x1) / 2;
      canvas.append(
        svg('rect', {
          x: mid - 46,
          y: (top + bottom) / 2 - 11,
          width: 92,
          height: 22,
          class: 'gap-label-bg',
        }),
        svg(
          'text',
          { x: mid, y: (top + bottom) / 2 + 5, 'text-anchor': 'middle', class: 'gap-label' },
          'No readings',
        ),
      );
    }
  }

  const warn = live?.data.thermalWarnC;
  if (metric === 'temperature' && warn != null && warn <= scale.max && warn >= scale.min) {
    canvas.append(
      svg('line', { x1: left, x2: right, y1: y(warn), y2: y(warn), class: 'warn-line' }),
      svg(
        'text',
        { x: right, y: y(warn) - 6, 'text-anchor': 'end', class: 'warn-label' },
        `Warning level ${warn}${NBSP}°C`,
      ),
    );
  }

  for (const run of runs) {
    if (run.length === 1) {
      canvas.append(svg('circle', { cx: x(run[0].at), cy: y(run[0].value), r: 2.5, class: 'dot' }));
      continue;
    }
    const d = run
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`)
      .join('');
    canvas.append(svg('path', { d, class: 'series' }));
  }

  const cursor = svg('line', { y1: top, y2: bottom, class: 'cursor' });
  const marker = svg('circle', { r: 4.5, class: 'marker' });
  cursor.setAttribute('visibility', 'hidden');
  marker.setAttribute('visibility', 'hidden');
  canvas.append(cursor, marker);

  view = {
    width,
    height,
    left,
    right,
    top,
    bottom,
    drawn,
    xs: drawn.map((p) => p.x),
    gaps: visibleGaps,
    slice: span / Math.max(1, w.points.length),
    cursor,
    marker,
    selected: -1,
  };
  if (selectedAt !== null && drawn.length)
    select(
      nearestIndex(
        drawn.map((p) => p.at),
        selectedAt,
      ),
    );
}

function showTip(x, y, lines) {
  const tip = $('tip');
  tip.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = lines[0];
  const detail = document.createElement('span');
  detail.textContent = lines[1];
  tip.append(heading, detail);
  tip.hidden = false;
  const half = tip.offsetWidth / 2;
  const clampedX = Math.max(half + 2, Math.min(view.width - half - 2, x));
  tip.style.left = `${clampedX}px`;
  const above = y - tip.offsetHeight - 12;
  tip.style.top = `${Math.max(0, y < view.height / 2 || above < 0 ? y + 14 : above)}px`;
}

function select(index, { speak = false } = {}) {
  if (!view || !view.drawn[index]) return;
  const point = view.drawn[index];
  const spec = METRICS[metric];
  view.selected = index;
  selectedAt = point.at;
  view.cursor.setAttribute('x1', point.x);
  view.cursor.setAttribute('x2', point.x);
  view.cursor.setAttribute('visibility', 'visible');
  view.marker.setAttribute('cx', point.x);
  view.marker.setAttribute('cy', point.y);
  view.marker.setAttribute('visibility', 'visible');
  const average = view.slice > 1.5 * SAMPLE_MS ? ` · ${formatSpan(view.slice)} average` : '';
  showTip(point.x, point.y, [
    stamp.format(point.at),
    `${spec.name} ${spec.format(point.value)}${average}`,
  ]);
  if (speak) setText('chart-live', `${stamp.format(point.at)}: ${spec.format(point.value)}`);
}

function selectGap(gap, x) {
  if (!view) return;
  selectedAt = null;
  view.selected = -1;
  view.cursor.setAttribute('visibility', 'hidden');
  view.marker.setAttribute('visibility', 'hidden');
  showTip(x, view.top + 8, [
    'No readings',
    `${shortStamp.format(gap.from)} to ${shortStamp.format(gap.to)}`,
  ]);
}

function clearSelection() {
  selectedAt = null;
  $('tip').hidden = true;
  if (view) {
    view.selected = -1;
    view.cursor.setAttribute('visibility', 'hidden');
    view.marker.setAttribute('visibility', 'hidden');
  }
}

function pointAt(event) {
  if (!view) return;
  const x = event.clientX - $('chart-svg').getBoundingClientRect().left;
  const gap = view.gaps.find((g) => x >= g.x0 && x <= g.x1);
  if (gap) selectGap(gap, x);
  else if (view.drawn.length) select(nearestIndex(view.xs, x));
}

// ---------------------------------------------------------------------------------------------
// History text and table
// ---------------------------------------------------------------------------------------------

function renderHistoryText() {
  const w = currentWindow();
  const spec = METRICS[metric];
  if (!w) {
    setText('summary', '');
    setText('chart-note', '');
    return;
  }
  setText('summary', summarySentence(metric, w.key, w[metric], spec.format));
  const notes = [coverageSentence(w.count, w.from, w.to)];
  const slice = (w.to - w.from) / Math.max(1, w.points.length);
  if (slice > 1.5 * SAMPLE_MS)
    notes.push(
      `The line shows the average of each ${formatSpan(slice)} slice, so a short peak looks lower on it than the highest single reading.`,
    );
  const { gaps } = runsAndGaps(w.points, metric, w.from, w.to);
  if (gaps.some((g) => g.to - Math.max(g.from, history.firstAt ?? g.from) > 2.5 * SAMPLE_MS))
    notes.push('Hatched stretches have no readings.');
  if (live && live.data.generatedAt - history.generatedAt > 600_000)
    notes.push(
      `The history is ${formatSpan(live.data.generatedAt - history.generatedAt)} behind the live readings.`,
    );
  setText('chart-note', notes.join(' '));
}

function renderTable() {
  const w = currentWindow();
  const body = $('table-body');
  body.replaceChildren();
  if (!w) return;
  const wide = w.to - w.from > 36 * HOUR;
  const fmt = wide ? shortStamp : clock;
  const cell = (text, header = false) => {
    const element = document.createElement(header ? 'th' : 'td');
    if (header) element.scope = 'row';
    element.textContent = text;
    return element;
  };
  for (const point of w.points) {
    if (point.cpu === null && point.memory === null && point.temperature === null) continue;
    const row = document.createElement('tr');
    row.append(
      cell(fmt.format(point.at), true),
      cell(point.cpu === null ? '–' : METRICS.cpu.format(point.cpu)),
      cell(point.memory === null ? '–' : METRICS.memory.format(point.memory)),
      cell(point.temperature === null ? '–' : METRICS.temperature.format(point.temperature)),
    );
    body.append(row);
  }
  const phrase = WINDOWS.find((x) => x.key === w.key)?.phrase ?? '';
  setText(
    'table-caption',
    `Averages per time slice over ${phrase}. Slices without a reading are left out.`,
  );
}

function syncControls() {
  const keys = availableWindows(history);
  for (const button of document.querySelectorAll('[data-window]'))
    button.hidden = !keys.includes(button.dataset.window);
  // One option is not a choice: a young archive only offers "All", so show no control at all.
  $('windows').hidden = keys.length < 2;
  if (!keys.includes(windowKey)) windowKey = keys.length ? defaultWindow(keys) : null;
  for (const button of document.querySelectorAll('[data-window]'))
    button.setAttribute('aria-pressed', String(button.dataset.window === windowKey));
  for (const button of document.querySelectorAll('[data-metric]'))
    button.setAttribute('aria-pressed', String(button.dataset.metric === metric));
}

function renderHistory() {
  renderArchiveNote();
  renderTrends();
  syncControls();
  renderChart();
  renderHistoryText();
  renderTable();
}

for (const button of document.querySelectorAll('[data-window]'))
  button.addEventListener('click', () => {
    windowKey = button.dataset.window;
    selectedAt = null;
    renderHistory();
  });
for (const button of document.querySelectorAll('[data-metric]'))
  button.addEventListener('click', () => {
    metric = button.dataset.metric;
    renderHistory();
  });

const chartBox = $('chart');
chartBox.addEventListener('pointerdown', pointAt);
chartBox.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'touch' || event.buttons) pointAt(event);
});
chartBox.addEventListener('pointerleave', (event) => {
  if (event.pointerType !== 'touch') clearSelection();
});
// A touch selection stays until the next tap lands somewhere else.
document.addEventListener('pointerdown', (event) => {
  if (!chartBox.contains(event.target)) clearSelection();
});
chartBox.addEventListener('blur', clearSelection);
chartBox.addEventListener('keydown', (event) => {
  if (!view?.drawn.length) return;
  const last = view.drawn.length - 1;
  let next = null;
  if (event.key === 'ArrowLeft') next = view.selected < 0 ? last : Math.max(0, view.selected - 1);
  else if (event.key === 'ArrowRight')
    next = view.selected < 0 ? last : Math.min(last, view.selected + 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = last;
  else if (event.key === 'Escape') {
    clearSelection();
    return;
  } else return;
  event.preventDefault();
  select(next, { speak: true });
});

let frame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (
      !view ||
      view.width !== Math.round(chartBox.clientWidth) ||
      view.height !== Math.round(chartBox.clientHeight)
    )
      renderChart();
  });
}).observe(chartBox);

// ---------------------------------------------------------------------------------------------
// Privacy dialog
// ---------------------------------------------------------------------------------------------

const dialog = $('privacy-dialog');
$('privacy-open').addEventListener('click', () => dialog.showModal());
$('privacy-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

async function request(path, signal, options = {}) {
  const response = await fetch(path, {
    signal,
    credentials: 'omit',
    redirect: 'error',
    ...options,
  });
  if (path === '/api/live') originUnavailable = isFallbackResponse(response);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

/** History changes every five minutes, so it is fetched only when /api/live says there is more. */
async function syncHistory(signal) {
  const wanted = live.data.historyGeneratedAt;
  if (wanted === null || wanted === undefined || history?.generatedAt === wanted) return;
  try {
    const next = await (await request('/api/history', signal, { cache: 'no-cache' })).json();
    if (signal.aborted) return;
    if (!Array.isArray(next?.windows)) throw new Error('Unsupported history');
    history = next;
    renderHistory();
  } catch {
    // Keep whatever history is already on screen; the next poll tries again.
  }
}

async function poll() {
  const id = ++requestId;
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await request('/api/live', controller.signal, { cache: 'no-store' });
    const payload = await response.json();
    if (id !== requestId) return;
    if (payload?.data?.schema !== 1 || !payload.status) throw new Error('Unsupported data');
    live = {
      data: payload.data,
      status: payload.status,
      receivedAt: performance.now(),
      preview: response.headers.get('X-Optimon-Preview') === 'sample-data',
    };
    failures = 0;
    renderLive();
    renderStatus();
    await syncHistory(controller.signal);
    if (id === requestId) renderHistoryText();
  } catch {
    if (id !== requestId || document.hidden) return;
    failures++;
    renderStatus();
  } finally {
    clearTimeout(timeout);
    if (inflight === controller) inflight = null;
  }
}

async function cycle(current) {
  if (current !== generation || document.hidden) return;
  await poll();
  if (current === generation && !document.hidden)
    pollTimer = setTimeout(() => cycle(current), POLL_MS);
}

function restart() {
  generation++;
  clearTimeout(pollTimer);
  inflight?.abort();
  if (!document.hidden) cycle(generation);
}

document.addEventListener('visibilitychange', restart);
window.addEventListener('online', restart);
setInterval(() => {
  if (!document.hidden) renderStatus();
}, 10_000);

renderStatus();
renderHistory();
restart();
