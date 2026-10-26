import test from 'node:test';
import assert from 'node:assert/strict';

// Tick placement depends on the local zone. Pin one that changes its clocks inside the test data.
process.env.TZ = 'Europe/Brussels';

const {
  DAY,
  HOUR,
  MINUTE,
  availableWindows,
  sampleCountSentence,
  defaultWindow,
  describeAge,
  describeMachine,
  formatSpan,
  freshness,
  nearestIndex,
  niceTicks,
  runsAndGaps,
  summarySentence,
  timeTicks,
  valueScale,
} = await import('../web/chart-model.js');

/** What queryDashboard produces: 96 slice averages that are null where a slice holds no sample. */
function slices(from, to, present = () => true) {
  const width = (to - from) / 96;
  return Array.from({ length: 96 }, (_, i) => {
    const start = Math.ceil(from + width * i);
    const end = Math.ceil(from + width * (i + 1));
    const hasMinute = Math.floor((end - 1) / MINUTE) > Math.floor((start - 1) / MINUTE);
    return {
      at: Math.floor((start + end) / 2),
      cpu: hasMinute && present(i) ? 2 + (i % 5) : null,
    };
  });
}

test('only windows the archive actually covers are offered, and 24h is the default when it is', () => {
  const at = Date.UTC(2026, 9, 24, 12);
  const history = (days) => ({ firstAt: at - days * DAY, lastAt: at });
  assert.deepEqual(availableWindows(history(10)), ['1h', '6h', '24h', '7d', 'all']);
  assert.deepEqual(availableWindows(history(400)), ['1h', '6h', '24h', '7d', '30d', '365d', 'all']);
  assert.deepEqual(availableWindows({ firstAt: at - 40 * MINUTE, lastAt: at }), ['all']);
  assert.deepEqual(availableWindows({ firstAt: null, lastAt: null }), []);
  assert.deepEqual(availableWindows(null), []);
  assert.equal(defaultWindow(['1h', '6h', '24h', '7d', 'all']), '24h');
  assert.equal(defaultWindow(['1h', '6h', 'all']), '6h');
  assert.equal(defaultWindow(['all']), 'all');
});

test('CPU and memory scales fit the data instead of a flat 0-100 axis', () => {
  assert.deepEqual(valueScale('cpu', [1.4, 2.1, 3.0]).ticks, [0, 5, 10]);
  assert.equal(valueScale('cpu', [1.4, 27]).max, 40);
  assert.equal(valueScale('memory', [12.1, 13.8]).max, 20);
  assert.deepEqual(valueScale('cpu', [96, 99]).ticks, [0, 25, 50, 75, 100]);
  assert.deepEqual(valueScale('cpu', []).ticks, [0, 25, 50, 75, 100]);
  for (const metric of ['cpu', 'memory']) assert.equal(valueScale(metric, [5]).min, 0);
});

test('the temperature scale follows the data and only includes the warning line when it is near', () => {
  const calm = valueScale('temperature', [31, 38], 80);
  assert.ok(calm.min <= 29 && calm.max >= 40 && calm.max < 80);
  const hot = valueScale('temperature', [55, 72], 80);
  assert.ok(hot.max >= 80, 'a reading within 15 degrees of the threshold brings it into view');
  const flat = valueScale('temperature', [40, 40], 80);
  assert.ok(flat.max - flat.min >= 10);
  assert.deepEqual(
    niceTicks(0, 31).ticks.map((v) => v % 10),
    [0, 0, 0, 0, 0],
  );
});

test('time ticks land on local clock boundaries, including across the autumn clock change', () => {
  // 2026-10-25 03:00 -> 02:00 in Europe/Brussels: this window is 25 hours long.
  const from = new Date(2026, 9, 24, 12, 0).getTime();
  const to = new Date(2026, 9, 25, 12, 0).getTime();
  assert.equal(to - from, 25 * HOUR);
  const day = timeTicks(from, to, 6);
  assert.ok(day.ticks.length >= 3 && day.ticks.length <= 6);
  for (const tick of day.ticks) {
    const when = new Date(tick);
    assert.equal(when.getMinutes(), 0);
    assert.equal(when.getHours() % 6, 0, `${when.toString()} should sit on a six-hour boundary`);
  }
  const hour = timeTicks(to - HOUR, to, 6);
  assert.ok(hour.ticks.length >= 3 && hour.ticks.length <= 6);
  for (const tick of hour.ticks) assert.equal(new Date(tick).getMinutes() % hour.step, 0);
  const week = timeTicks(to - 7 * DAY, to, 6);
  assert.equal(week.unit, 'd');
  for (const tick of week.ticks) assert.equal(new Date(tick).getHours(), 0);
  const month = timeTicks(to - 30 * DAY, to, 6);
  for (const tick of month.ticks)
    assert.equal(new Date(tick).getDay(), 1, 'weekly ticks are Mondays');
  const year = timeTicks(to - 400 * DAY, to, 6);
  assert.equal(year.unit, 'M');
  for (const tick of year.ticks) assert.equal(new Date(tick).getDate(), 1);
  assert.ok(year.ticks.length <= 6);
  assert.deepEqual(timeTicks(to, from).ticks, []);
});

test('a one-hour chart is not broken into fragments just because slices are shorter than samples', () => {
  const to = Date.UTC(2026, 9, 24, 20, 43, 30);
  const from = to - HOUR;
  const points = slices(from, to);
  const empty = points.filter((p) => p.cpu === null).length;
  assert.ok(empty > 30, `the real export leaves ${empty} of 96 slices empty at 1h`);
  const { runs, gaps } = runsAndGaps(points, 'cpu', from, to);
  assert.equal(runs.length, 1);
  assert.equal(gaps.length, 0);
  assert.equal(runs[0].length, 96 - empty);
  // One genuinely missing minute is not an outage either.
  const missingMinute = slices(from, to, (i) => i !== 40 && i !== 41);
  assert.equal(runsAndGaps(missingMinute, 'cpu', from, to).gaps.length, 0);
});

test('real outages become gaps, with leading and trailing missing time reported too', () => {
  const to = Date.UTC(2026, 9, 24, 20, 43, 30);
  const from = to - DAY;
  const points = slices(from, to, (i) => i < 40 || i > 52);
  const { runs, gaps } = runsAndGaps(points, 'cpu', from, to);
  assert.equal(runs.length, 2);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, points[39].at);
  assert.equal(gaps[0].to, points[53].at);
  assert.ok(gaps[0].to - gaps[0].from > 3 * HOUR);
  const young = runsAndGaps(
    slices(from, to, (i) => i >= 60),
    'cpu',
    from,
    to,
  );
  assert.equal(young.runs.length, 1);
  assert.equal(young.gaps[0].from, from);
  const silent = runsAndGaps(
    slices(from, to, (i) => i < 70),
    'cpu',
    from,
    to,
  );
  assert.equal(silent.gaps.at(-1).to, to);
  assert.deepEqual(
    runsAndGaps(
      slices(from, to, () => false),
      'cpu',
      from,
      to,
    ),
    {
      runs: [],
      gaps: [{ from, to }],
    },
  );
});

test('the pointer picks the closest drawn point', () => {
  assert.equal(nearestIndex([10, 20, 30], 12), 0);
  assert.equal(nearestIndex([10, 20, 30], 26), 2);
  assert.equal(nearestIndex([10, 20, 30], 1000), 2);
  assert.equal(nearestIndex([], 5), -1);
});

test('freshness trusts the server clock, so a wrong visitor clock cannot fake a stale page', () => {
  const live = { state: 'live', ageSeconds: 10 };
  // A visitor whose clock is a year out: only the difference between two of its own readings counts.
  const received = Date.UTC(2031, 0, 1);
  assert.deepEqual(freshness(live, received, received + 5000), {
    state: 'live',
    age: 15_000,
    connected: true,
  });
  // 10 s old when it arrived: still live at 175 s, stale once past 180 s.
  assert.equal(freshness(live, received, received + 165_000).state, 'live');
  assert.equal(freshness(live, received, received + 171_000).state, 'stale');
  assert.equal(freshness({ state: 'stale', ageSeconds: 4000 }, received, received).state, 'stale');
  assert.equal(freshness(live, received, received + 91_000).connected, false);
});

test('ages and spans read as plain English', () => {
  assert.equal(describeAge(0), 'just now');
  assert.equal(describeAge(4000), 'just now');
  assert.equal(describeAge(5000), '5 seconds ago');
  assert.equal(describeAge(20_000), '20 seconds ago');
  assert.equal(describeAge(90_000), '2 minutes ago');
  assert.equal(describeAge(3 * HOUR), '3 hours ago');
  assert.equal(describeAge(5 * DAY), '5 days ago');
  assert.equal(formatSpan(9 * DAY + 23 * HOUR), '9 d 23 h');
  assert.equal(formatSpan(5 * HOUR + 14 * MINUTE), '5 h 14 min');
  assert.equal(formatSpan(12 * MINUTE), '12 min');
});

test('summary and sample-count sentences do not infer uptime from a nominal cadence', () => {
  const format = (v) => `${v.toFixed(1)}%`;
  const aggregate = { count: 1440, min: 1.4, mean: 2.7, max: 27 };
  assert.equal(
    summarySentence('cpu', '24h', aggregate, format),
    'Over the last 24 hours, CPU use averaged 2.7%, peaked at 27.0% and never went below 1.4%.',
  );
  assert.equal(
    summarySentence('memory', 'all', aggregate, format),
    'Across everything recorded so far, memory use averaged 2.7%, peaked at 27.0% and never went below 1.4%.',
  );
  assert.equal(
    summarySentence('temperature', '1h', aggregate, (v) => `${v.toFixed(1)} °C`),
    'Over the last hour, the CPU ran at 2.7 °C on average, peaked at 27.0 °C and never cooled below 1.4 °C.',
  );
  assert.match(summarySentence('cpu', '7d', null, format), /no readings/);
  for (const count of [1260, 1404, 1440]) {
    const text = sampleCountSentence(count);
    assert.ok(text.startsWith(`${count.toLocaleString('en-GB')} archived samples`));
    assert.match(text, /this count is not an uptime measurement/);
    assert.doesNotMatch(text, /%|minutes in this period have/);
  }
  assert.match(sampleCountSentence(1), /^1 archived sample in/);
  assert.equal(sampleCountSentence(0), 'No archived samples in this period.');
});

test('spring clock-change ticks are unique and ordered when a missing hour normalizes forward', () => {
  const from = new Date(2026, 2, 29, 1, 0).getTime();
  const to = new Date(2026, 2, 29, 4, 0).getTime();
  assert.equal(to - from, 2 * HOUR);
  const { ticks } = timeTicks(from, to, 8);
  assert.ok(ticks.length >= 3);
  assert.equal(
    new Set(ticks).size,
    ticks.length,
    '02:xx and 03:xx must not produce duplicate 03:xx ticks',
  );
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1]);
});

test('status verdicts do not call missing core readings quiet, and alarms keep priority', () => {
  const data = {
    thermalWarnC: 80,
    thermalRecoverC: 75,
    live: {
      hostUptime: 3600,
      cpuPercent: 5,
      memory: { percent: 20 },
      temperatures: [{ label: 'Core 0', celsius: 31 }],
    },
  };
  assert.equal(describeMachine(data, 1000).verdict, 'All quiet.');
  const partial = { ...data, live: { ...data.live, temperatures: [] } };
  assert.equal(describeMachine(partial, 1000).verdict, 'Some readings unavailable.');
  assert.match(describeMachine(partial, 1000).detail, /temperatures/);
  const missing = { ...partial, live: { ...partial.live, cpuPercent: null, memory: null } };
  assert.equal(describeMachine(missing, 1000).verdict, 'Readings unavailable.');
  const hot = {
    ...missing,
    live: { ...missing.live, temperatures: [{ label: 'Core 0', celsius: 82 }] },
  };
  assert.equal(describeMachine(hot, 1000).verdict, 'Running hot.');
  assert.equal(
    describeMachine({ ...partial, live: { ...partial.live, memory: { percent: 95 } } }, 1000)
      .verdict,
    'Short on memory.',
  );
  assert.equal(
    describeMachine({ ...partial, live: { ...partial.live, cpuPercent: 90 } }, 1000).verdict,
    'Working hard.',
  );
});
