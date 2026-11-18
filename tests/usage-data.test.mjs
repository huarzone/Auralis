import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  MIN, HOUR, DAY, RANGES, HEAT_CELLS, rangeWindow, analyze, modelGroups,
  activityCells, tokenLevels, healthLevel, smoothPath, ribbonLayout, speedComparison, sessionMatrix,
} = require('../src/usage-data.cjs');

const call = (overrides = {}) => ({
  time: 0, provider: 'p', model: 'shared', session: 's1', ok: true,
  input: 10, cacheRead: 20, cacheWrite: 30, output: 40, total: 100, reasoning: 15,
  ttft: 100, duration: 1100, ...overrides,
});
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

// These tests exercise only pure helpers: no browser, server or filesystem fixtures.
test('live ranges expose 15, 30 and 60 minute windows', () => {
  const live = RANGES.filter(range => range.live);
  assert.deepEqual(live.map(range => range.id), ['15m', '30m', '1h']);
  assert.deepEqual(live.map(range => range.label.replaceAll(' ', '')), ['15分钟', '30分钟', '60分钟']);
  for (const [id, minutes] of [['15m', 15], ['30m', 30], ['1h', 60]]) {
    const win = rangeWindow(id, DAY);
    assert.equal(win.end - win.start, minutes * MIN);
    assert.ok(win.step > 0 && Number.isFinite(win.step));
  }
});

test('unknown ranges fall back to 24 hours and invalid first timestamps cannot poison all', () => {
  assert.deepEqual(rangeWindow('unknown', DAY, 0), rangeWindow('24h', DAY));
  assert.deepEqual(rangeWindow('all', DAY, NaN), rangeWindow('all', DAY));
  assert.deepEqual(rangeWindow('all', DAY, Infinity), rangeWindow('all', DAY));
  const all = rangeWindow('all', DAY, DAY - 5000 * DAY);
  assert.ok((all.end - all.start) / all.step <= 48);
});

test('analyze retains token and histogram totals with finite successful latency samples', () => {
  const rows = [
    call({ time: 10 }),
    call({ time: 20, provider: 'q', ttft: 0, duration: 0 }),
    call({ time: 30, ttft: Infinity, duration: NaN }),
    call({ time: 40, ttft: NaN, duration: -1 }),
    call({ time: 50, ok: false, code: 'RATE_LIMIT', ttft: 20, duration: 30 }),
    call({ time: 60, ttft: -1, duration: Infinity }),
    call({ time: NaN }),
  ];
  const stats = analyze(rows, { start: 0, end: MIN, step: MIN });
  assert.equal(stats.kpi.calls, 6);
  assert.equal(stats.kpi.failed, 1);
  assert.equal(stats.kpi.total, 600);
  assert.equal(stats.kpi.input + stats.kpi.cacheRead + stats.kpi.cacheWrite + stats.kpi.output, 600);
  assert.equal(stats.kpi.reasoning, 90, 'reasoning remains a subset of output, not another stacked part');
  assert.deepEqual(stats.points, [{ ttft: 100, duration: 1100, key: 'p/shared' }]);
  assert.deepEqual(stats.ttft, { p50: 0, p95: 100, count: 2 });
  assert.deepEqual(stats.duration, { p50: 0, p95: 1100, count: 2 });
  assert.equal(sum(stats.histogram, 'ttft'), 2);
  assert.equal(sum(stats.histogram, 'duration'), 2);
  assert.deepEqual(stats.series[0].models, { 'p/shared': 500, 'q/shared': 100 });
  assert.equal(sum(stats.models, 'total'), 600);
  assert.equal(sum(stats.sessions, 'total'), 600);
  assert.deepEqual(stats.errors.map(error => [error.code, error.count]), [['RATE_LIMIT', 1]]);
});

test('analyze supplies actual bucket spans and normalizes sub-minute windows', () => {
  const win = { start: 1000, end: 1000 + 1.5 * MIN, step: MIN };
  const stats = analyze([call({ time: win.start }), call({ time: win.end })], win);
  assert.deepEqual(stats.series.map(bucket => bucket.span), [MIN, MIN / 2]);
  assert.deepEqual(stats.series.map(bucket => bucket.calls), [1, 1]);
  assert.equal(stats.series[1].total / (stats.series[1].span / MIN), 200);
  assert.equal(stats.kpi.rpm, 2 / 1.5);
  const short = analyze([call()], { start: 0, end: MIN / 2, step: MIN });
  assert.equal(short.kpi.rpm, 2);
  assert.equal(short.kpi.tpm, 200);
  const instant = analyze([call()], { start: 0, end: 0, step: MIN });
  assert.equal(instant.series[0].span, 0);
  assert.ok(Number.isFinite(instant.kpi.rpm));
  assert.ok(Number.isFinite(instant.kpi.tpm));
});

test('today immediately after midnight uses its actual elapsed minutes for KPI rates', () => {
  const midnight = new Date(2026, 10, 5).getTime();
  const win = rangeWindow('today', midnight + 30_000);
  const stats = analyze([call({ time: midnight + 10_000 })], win);
  assert.equal(stats.series[0].span, 30_000);
  assert.equal(stats.kpi.rpm, 2);
  assert.equal(stats.kpi.tpm, 200);
});

test('yesterday excludes the exact midnight that belongs to today', () => {
  const midnight = new Date(2026, 10, 5).getTime();
  const win = rangeWindow('yesterday', midnight + HOUR);
  const rows = [call({ time: win.start }), call({ time: midnight - 1 }), call({ time: midnight })];
  assert.equal(win.end, midnight);
  assert.equal(analyze(rows, win).kpi.calls, 2);
  const comparison = speedComparison(rows, win)[0];
  assert.equal(comparison.beforeCount + comparison.afterCount, 2);
});

test('nonfinite or negative token fields do not leak into aggregate arithmetic', () => {
  const stats = analyze([call({ total: NaN, input: -1, output: Infinity, cacheRead: undefined, cacheWrite: NaN, reasoning: Infinity })], { start: 0, end: MIN, step: MIN });
  for (const field of ['total', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tpm', 'cacheRate']) {
    assert.equal(stats.kpi[field], 0);
  }
});

test('model groups take the top five without changing input and conserve totals in other', () => {
  const models = Array.from({ length: 8 }, (_, index) => ({
    key: `p/m${index}`, provider: 'p', model: `m${index}`, total: index * 10, calls: index + 1, failed: index % 2,
  }));
  const groups = modelGroups(models);
  assert.equal(groups.length, 6);
  assert.deepEqual(groups.slice(0, 5).map(group => group.key), ['p/m7', 'p/m6', 'p/m5', 'p/m4', 'p/m3']);
  assert.equal(groups[5].key, 'other');
  assert.deepEqual(groups[5].keys, ['p/m2', 'p/m1', 'p/m0']);
  for (const field of ['total', 'calls', 'failed']) assert.equal(sum(groups, field), sum(models, field));
  assert.equal(models[0].key, 'p/m0');
  assert.deepEqual(modelGroups([]), []);
});

test('rolling activity periods always have 364 contiguous cells and exclude future calls', () => {
  const now = 100 * DAY;
  for (const [period, span] of [['day', DAY], ['week', 7 * DAY], ['month', 30 * DAY]]) {
    const cells = activityCells([
      call({ time: now - span }), call({ time: now }), call({ time: now - span - 1 }),
      call({ time: now + 1 }), call({ time: NaN }),
    ], period, now);
    assert.equal(cells.length, HEAT_CELLS);
    assert.equal(cells[0].start, now - span);
    assert.equal(cells.at(-1).end, now);
    assert.equal(sum(cells, 'calls'), 2);
    assert.equal(sum(cells, 'total'), 200);
    assert.ok(cells.every((cell, index) => cell.end > cell.start && (index === 0 || cell.start === cells[index - 1].end)));
  }
});

test('activity boundary timestamps belong to the cell starting at that boundary', () => {
  const now = 100 * DAY;
  for (const period of ['day', 'week', 'month']) {
    const bounds = activityCells([], period, now);
    const cells = activityCells(bounds.map(cell => call({ time: cell.start })), period, now);
    assert.ok(cells.every(cell => cell.calls === 1), period);
  }
});

test('yearly activity aligns all 364 local calendar days across both DST transitions', () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const now = new Date(2026, 10, 2, 12).getTime();
    const start = new Date(2025, 10, 4).getTime();
    const cells = activityCells([
      call({ time: start }), call({ time: now }), call({ time: now + HOUR }),
      call({ time: new Date(2026, 2, 8, 23, 30).getTime() }),
      call({ time: new Date(2026, 10, 1, 23, 30).getTime() }),
      call({ time: start - 1 }),
    ], 'year', now);
    assert.equal(cells.length, 364);
    assert.equal(cells[0].start, start);
    assert.equal(cells.at(-1).end, new Date(2026, 10, 3).getTime());
    assert.equal(sum(cells, 'calls'), 4);
    assert.equal(sum(cells, 'total'), 400);
    assert.ok(cells.every((cell, index) => new Date(cell.start).getHours() === 0 && (index === 0 || cell.start === cells[index - 1].end)));
    assert.equal(cells.find(cell => cell.start === new Date(2026, 2, 8).getTime()).end - new Date(2026, 2, 8).getTime(), 23 * HOUR);
    assert.equal(cells.find(cell => cell.start === new Date(2026, 10, 1).getTime()).end - new Date(2026, 10, 1).getTime(), 25 * HOUR);
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test('token levels handle empty, flat, invalid and wide numeric distributions', () => {
  assert.deepEqual(tokenLevels([]), []);
  assert.deepEqual(tokenLevels([0, -1, NaN, Infinity, -Infinity]), [0, 0, 0, 0, 0]);
  assert.deepEqual(tokenLevels([0, 7, 7]), [0, 5, 5]);
  const levels = tokenLevels([1, 10, 100, 1000, 1e10]);
  assert.ok(levels.every(level => Number.isInteger(level) && level >= 1 && level <= 5));
  assert.ok(levels.every((level, index) => index === 0 || level >= levels[index - 1]));
  assert.deepEqual(tokenLevels([1e308, 1e308 + 1e292]), [5, 5]);
});

test('health levels reject invalid sample totals and clamp success counts', () => {
  for (const total of [0, -1, NaN, Infinity]) assert.equal(healthLevel(1, total), 0);
  assert.equal(healthLevel(NaN, 100), 1);
  assert.equal(healthLevel(-10, 100), 1);
  assert.equal(healthLevel(200, 100), 5);
  assert.equal(healthLevel(0, 100), 1);
  assert.equal(healthLevel(90, 100), 4);
  assert.equal(healthLevel(100, 100), 5);
});

test('smooth paths handle empty, isolated, duplicate and invalid coordinates without nonfinite SVG', () => {
  assert.equal(smoothPath([]), '');
  assert.equal(smoothPath([[2, 3]]), 'M2 3');
  assert.equal(smoothPath([[NaN, 2], [2, Infinity]]), '');
  const path = smoothPath([[0, 0], [0, 10], [1, 8], [NaN, 4], [2, 10]]);
  assert.match(path, /^M0 0 C/);
  assert.doesNotMatch(path, /NaN|Infinity/);
  assert.match(path, / 2 10$/);
});

test('smooth paths fall back to finite segments when intermediate slopes overflow', () => {
  const path = smoothPath([[0, 0], [1e-320, 1], [1, 2], [1e308, -1e308]]);
  assert.doesNotMatch(path, /NaN|Infinity/);
  assert.match(path, /1e\+308 -1e\+308$/);
});

test('ribbon geometry stays finite and conserves normalized positive shares', () => {
  for (const shares of [[], [0, 0], [NaN, Infinity, -1], [2, 3, 0]]) {
    const layout = ribbonLayout(shares, { width: 300, rowHeight: 40 });
    for (const field of ['height', 'width', 'srcY', 'srcH', 'endX']) assert.ok(Number.isFinite(layout[field]));
    assert.equal(layout.ribbons.length, shares.length);
    for (const ribbon of layout.ribbons) {
      assert.ok(ribbon.thickness >= 0 && ribbon.thickness <= 40 * 0.78);
      assert.doesNotMatch(ribbon.d, /NaN|Infinity/);
    }
    if (shares.every(share => !(Number.isFinite(share) && share > 0))) assert.equal(layout.srcH, 0);
    else assert.ok(Math.abs(sum(layout.ribbons, 'thickness') - layout.srcH) <= 0.02);
  }
  const invalidSize = ribbonLayout([1], { width: Infinity, rowHeight: NaN });
  assert.doesNotMatch(JSON.stringify(invalidSize), /NaN|Infinity|null/);
});

test('speed comparisons pool output over generation time in each half rather than average rates', () => {
  assert.equal(typeof speedComparison, 'function');
  const rows = [
    call({ time: 0, output: 100, ttft: 100, duration: 1100 }),
    call({ time: 20, output: 100, ttft: 200, duration: 3200 }),
    call({ time: 50, output: 200, ttft: 100, duration: 2100 }),
    call({ time: 100, output: 100, ttft: 0, duration: 1000 }),
    call({ time: 10, provider: 'q', output: 12, ttft: 0, duration: 1000 }),
    call({ time: 90, provider: 'r', output: 24, ttft: 0, duration: 1000 }),
  ];
  const compared = speedComparison(rows, { start: 0, end: 100 });
  assert.deepEqual(compared.find(row => row.key === 'p/shared'), {
    key: 'p/shared', model: 'shared', provider: 'p', before: 50, after: 100, beforeCount: 2, afterCount: 2,
  });
  assert.equal(compared.find(row => row.key === 'q/shared').after, undefined);
  assert.equal(compared.find(row => row.key === 'q/shared').afterCount, 0);
  assert.equal(compared.find(row => row.key === 'r/shared').before, undefined);
});

test('speed comparisons exclude unsuccessful or invalid samples but keep missing rates undefined', () => {
  assert.equal(typeof speedComparison, 'function');
  const rows = [
    call({ time: -1 }), call({ time: 101 }), call({ time: NaN }),
    call({ time: 10, ok: false }), call({ time: 20, output: 0 }),
    call({ time: 30, output: Infinity }), call({ time: 40, duration: 100 }),
    call({ time: 50, ttft: -1 }), call({ time: 60, ttft: undefined }),
    call({ time: 70, duration: Infinity }), call({ time: 80, ttft: NaN }),
  ];
  assert.deepEqual(speedComparison(rows, { start: 0, end: 100 }), [{
    key: 'p/shared', model: 'shared', provider: 'p', before: undefined, after: undefined, beforeCount: 0, afterCount: 0,
  }]);
});

test('session matrix preserves every supplied session and maps provider-aware other columns', () => {
  assert.equal(typeof sessionMatrix, 'function');
  const groups = [
    { key: 'p/shared', keys: ['p/shared'] },
    { key: 'other', keys: ['q/shared', 'r/extra'] },
  ];
  const sessions = [{ id: 'empty', total: 999 }, { id: 's2' }, ...Array.from({ length: 14 }, (_, i) => ({ id: `s${i + 3}` })), { id: 's1' }];
  const matrix = sessionMatrix([
    call({ session: 's1' }), call({ session: 's1', provider: 'q' }),
    call({ session: 's2', provider: 'r', model: 'extra', total: 75 }),
  ], sessions, groups);
  assert.equal(matrix.columns, groups);
  assert.deepEqual(matrix.rows.map(row => row.id), sessions.map(session => session.id));
  assert.deepEqual(matrix.rows[0], { id: 'empty', total: 0, calls: 0, values: [0, 0] });
  assert.deepEqual(matrix.rows[1], { id: 's2', total: 75, calls: 1, values: [0, 75] });
  assert.deepEqual(matrix.rows.at(-1), { id: 's1', total: 200, calls: 2, values: [100, 100] });
  assert.equal(sum(matrix.rows, 'total'), 275);
  assert.equal(sum(matrix.rows, 'calls'), 3);
  assert.ok(matrix.rows.every(row => row.total === row.values.reduce((total, value) => total + value, 0)));
  assert.deepEqual(sessionMatrix([], ['empty'], []), { columns: [], rows: [{ id: 'empty', total: 0, calls: 0, values: [] }] });
});
