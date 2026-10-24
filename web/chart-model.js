// Pure helpers behind the charts and the status line. Nothing here touches the DOM, so
// `node --test` exercises exactly the code the browser runs.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** One reading per minute. */
export const SAMPLE_MS = MINUTE;
/** Keep in step with PUBLIC_STALE_MS in src/dashboard-data.ts. */
export const STALE_MS = 180_000;

export const WINDOWS = [
  { key: '1h', minutes: 60, label: '1h', phrase: 'the last hour' },
  { key: '6h', minutes: 360, label: '6h', phrase: 'the last 6 hours' },
  { key: '24h', minutes: 1440, label: '24h', phrase: 'the last 24 hours' },
  { key: '7d', minutes: 10080, label: '7d', phrase: 'the last 7 days' },
  { key: '30d', minutes: 43200, label: '30d', phrase: 'the last 30 days' },
  { key: '365d', minutes: 525600, label: '1y', phrase: 'the last year' },
  { key: 'all', minutes: 0, label: 'All', phrase: 'everything recorded so far' },
];

/**
 * A window wider than the archive is mostly empty (a 10-day-old archive would fill 3 of the
 * 96 slices of "1y"), so only offer windows the recorded history actually covers.
 */
export function availableWindows(history) {
  if (!history || history.firstAt === null || history.lastAt === null) return [];
  const span = history.lastAt - history.firstAt;
  return WINDOWS.filter((w) => w.minutes === 0 || w.minutes * MINUTE <= span * 1.05).map(
    (w) => w.key,
  );
}

export function defaultWindow(keys) {
  if (keys.includes('24h')) return '24h';
  return [...keys].reverse().find((key) => key !== 'all') ?? 'all';
}

/** Round the range outward to tidy tick values. Steps are 1, 2, 5 or 10 times a power of ten. */
export function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const rough = span / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = low; v <= high + step / 1000; v += step) ticks.push(Number(v.toFixed(6)));
  return { min: low, max: high, ticks };
}

const PERCENT = { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] };

/**
 * CPU and memory start at zero but only run as high as the data needs (an idle server would
 * otherwise be a flat line at the bottom of a 0-100 chart). Temperature follows its own range
 * and includes the warning threshold once readings get anywhere near it.
 */
export function valueScale(metric, values, warnC = null) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return metric === 'temperature' ? niceTicks(20, 60) : PERCENT;
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  if (metric === 'temperature') {
    const top = warnC !== null && high >= warnC - 15 ? Math.max(high, warnC) : high;
    const bottom = Math.floor(low - 2);
    return niceTicks(bottom, Math.max(Math.ceil(top + 2), bottom + 10));
  }
  const scale = niceTicks(0, Math.max(high * 1.15, metric === 'cpu' ? 10 : 20));
  return scale.max > 100 ? PERCENT : scale;
}

const TICK_STEPS = [
  ['m', 10],
  ['m', 15],
  ['m', 30],
  ['m', 60],
  ['m', 120],
  ['m', 180],
  ['m', 360],
  ['m', 720],
  ['d', 1],
  ['d', 2],
  ['d', 7],
  ['d', 14],
  ['M', 1],
  ['M', 3],
  ['M', 6],
  ['M', 12],
];
const UNIT_MS = { m: MINUTE, d: DAY, M: 30 * DAY };

function generateTicks(unit, n, from, to) {
  const out = [];
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  if (unit === 'm') {
    // Local-clock arithmetic, so 06:00 stays 06:00 on the day the clocks change.
    for (const day = new Date(start); day.getTime() <= to; day.setDate(day.getDate() + 1))
      for (let minute = 0; minute < 1440; minute += n) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minute).getTime();
        if (at >= from && at <= to) out.push(at);
      }
  } else if (unit === 'd') {
    if (n >= 7) start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // weeks start on Monday
    for (const day = new Date(start); day.getTime() <= to; day.setDate(day.getDate() + n))
      if (day.getTime() >= from) out.push(day.getTime());
  } else {
    start.setDate(1);
    start.setMonth(Math.floor(start.getMonth() / n) * n);
    for (const month = new Date(start); month.getTime() <= to; month.setMonth(month.getMonth() + n))
      if (month.getTime() >= from) out.push(month.getTime());
  }
  return out;
}

/** Tick times on tidy local boundaries: the smallest step that gives at most `maxTicks`. */
export function timeTicks(from, to, maxTicks = 6) {
  if (!(to > from) || maxTicks < 2) return { unit: 'm', step: 0, ticks: [] };
  let best = { unit: 'M', step: 12, ticks: [] };
  for (const [unit, n] of TICK_STEPS) {
    if ((to - from) / (n * UNIT_MS[unit]) > maxTicks * 3) continue; // far too dense; skip the work
    best = { unit, step: n, ticks: generateTicks(unit, n, from, to) };
    if (best.ticks.length <= maxTicks) break;
  }
  return best;
}

/**
 * Split bucket averages into continuous runs and the gaps between them. Points are placed by
 * time, and a gap is a real stretch without readings: longer than 2.5 samples and longer than
 * 1.5 slices. That matters at "1h", where the slices (37.5 s) are shorter than the sample
 * interval, so most of the 96 slices are empty even though nothing is missing.
 */
export function runsAndGaps(points, key, from, to) {
  const slice = (to - from) / Math.max(1, points.length);
  const limit = Math.max(2.5 * SAMPLE_MS, slice * 1.5);
  const runs = [];
  const gaps = [];
  let run = [];
  let previous = null;
  for (const point of points) {
    const value = point[key];
    if (value === null || value === undefined) continue;
    if (previous && point.at - previous.at > limit) {
      runs.push(run);
      gaps.push({ from: previous.at, to: point.at });
      run = [];
    }
    run.push({ at: point.at, value });
    previous = point;
  }
  if (!previous) return { runs: [], gaps: [{ from, to }] };
  runs.push(run);
  const first = runs[0][0].at;
  if (first - from > limit) gaps.unshift({ from, to: first });
  if (to - previous.at > limit) gaps.push({ from: previous.at, to });
  return { runs, gaps };
}

/** Index of the position closest to x. `positions` must be sorted ascending. */
export function nearestIndex(positions, x) {
  let best = -1;
  let distance = Infinity;
  for (let i = 0; i < positions.length; i++) {
    const d = Math.abs(positions[i] - x);
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return best;
}

/**
 * Age comes from the server's own clock (ageSeconds at the moment it answered) plus the time
 * since the answer arrived. A visitor's wrong clock can no longer make fresh data look stale.
 */
export function freshness(status, receivedAt, now) {
  const age = Math.max(0, status.ageSeconds * 1000 + (now - receivedAt));
  const sinceAnswer = now - receivedAt;
  return {
    state: status.state === 'stale' || age > STALE_MS ? 'stale' : 'live',
    age,
    // No answer for 90 s means we cannot say what the machine is doing, only what we last saw.
    connected: sinceAnswer <= 90_000,
  };
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

export function describeAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${plural(seconds, 'second')} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.round(hours / 24), 'day')} ago`;
}

const NBSP = ' ';
/** "9 d 23 h", "5 h 14 min", "12 min". Non-breaking spaces keep each figure with its unit. */
export function formatSpan(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return `${days}${NBSP}d ${hours}${NBSP}h`;
  if (hours) return `${hours}${NBSP}h ${rest}${NBSP}min`;
  return `${rest}${NBSP}min`;
}

/** A sentence, not four tiles: what the period looked like, in plain words. */
export function summarySentence(metric, windowKey, aggregate, format) {
  if (!aggregate) return 'There are no readings for this metric in this period.';
  const window = WINDOWS.find((w) => w.key === windowKey);
  const lead = windowKey === 'all' ? 'Across everything recorded so far' : `Over ${window.phrase}`;
  const [mean, peak, floor] = [aggregate.mean, aggregate.max, aggregate.min].map(format);
  if (metric === 'temperature')
    return `${lead}, the CPU ran at ${mean} on average, peaked at ${peak} and never cooled below ${floor}.`;
  const name = metric === 'cpu' ? 'CPU use' : 'memory use';
  return `${lead}, ${name} averaged ${mean}, peaked at ${peak} and never went below ${floor}.`;
}

export function coverageSentence(count, from, to, locale = 'en-GB') {
  const expected = Math.max(1, Math.round((to - from) / SAMPLE_MS));
  if (count >= expected * 0.995) return 'There is a reading for nearly every minute.';
  const share = ((Math.min(count, expected) / expected) * 100).toFixed(1);
  const n = new Intl.NumberFormat(locale);
  return `${share}% of the minutes in this period have a reading (${n.format(count)} of ${n.format(expected)}).`;
}
