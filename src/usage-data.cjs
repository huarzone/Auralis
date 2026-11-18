/**
 * 使用分析的数据层，全部为纯函数，供 usage-view.cjs 渲染。
 * 核心：rangeWindow（时间范围 → 分桶窗口）、analyze（调用行 → KPI / 序列 / 分布 / 散点）、
 * activityCells + tokenLevels / healthLevel（52×7 活动热力格）、modelGroups（前 5 模型 + 其他）、
 * speedComparison（分半区间的估算生成速率）、sessionMatrix（会话 × 模型用量）、
 * smoothPath（单调三次曲线）与 ribbonLayout（缎带几何）。数据来自 `api/auralis.usage`，不计算费用。
 */
'use strict';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const USAGE_ROUTE = 'api/auralis.usage';

// live 范围每 10 秒刷新，其余 60 秒。
const RANGES = [
  { id: '15m', label: '15 分钟', live: true }, { id: '30m', label: '30 分钟', live: true },
  { id: '1h', label: '60 分钟', live: true }, { id: '24h', label: '24 小时' },
  { id: 'today', label: '今天' }, { id: 'yesterday', label: '昨天' }, { id: '7d', label: '7 天' },
  { id: '30d', label: '30 天' }, { id: 'all', label: '全部' },
];
const PERIODS = [
  { id: 'day', label: '日', span: DAY }, { id: 'week', label: '周', span: 7 * DAY },
  { id: 'month', label: '月', span: 30 * DAY }, { id: 'year', label: '年', span: 364 * DAY },
];
const HEAT_CELLS = 364;
const STEPS = [MIN, 2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
// TokenUsage 的四个字段互不重叠，堆叠后即为总量；推理 token 属于输出，只单独展示。
const TOKEN_PARTS = [
  { key: 'input', label: '输入', color: '#3b82f6', light: '#93c5fd' },
  { key: 'cacheRead', label: '缓存读', color: '#14b8a6', light: '#5eead4' },
  { key: 'cacheWrite', label: '缓存写', color: '#8b5cf6', light: '#c4b5fd' },
  { key: 'output', label: '输出', color: '#f97316', light: '#fdba74' },
];
const SUMMED = ['total', ...TOKEN_PARTS.map(part => part.key)];
const PALETTE = ['#4d8bdc', '#269c85', '#9671ce', '#d99637', '#d1698c'];
const OTHER_COLOR = '#a5b0c0';

function startOfDay(time) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 时间范围 → `{start, end, step}`；昨天不含结束午夜，`all` 从最早调用开始，约 48 个桶。 */
function rangeWindow(id, now, firstTime) {
  const today = startOfDay(now);
  switch (id) {
    case '15m': return { start: now - 15 * MIN, end: now, step: 30 * SEC };
    case '30m': return { start: now - 30 * MIN, end: now, step: MIN };
    case '1h': return { start: now - HOUR, end: now, step: MIN };
    case '24h': return { start: now - DAY, end: now, step: HOUR };
    case 'today': return { start: today, end: now, step: HOUR };
    case 'yesterday': return { start: startOfDay(today - 1), end: today, step: HOUR, endExclusive: true };
    case '7d': return { start: now - 7 * DAY, end: now, step: 6 * HOUR };
    case '30d': return { start: now - 30 * DAY, end: now, step: DAY };
    case 'all': {
      const start = Math.min(Number.isFinite(firstTime) ? firstTime : now, now - HOUR);
      const target = (now - start) / 48;
      return { start, end: now, step: STEPS.find(step => step >= target) ?? Math.ceil(target / DAY) * DAY };
    }
    default: return { start: now - DAY, end: now, step: HOUR };
  }
}

/** 最近秩百分位；输入须已升序。 */
function percentile(sorted, p) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : undefined;
}

function latencyStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), count: sorted.length };
}

function cacheRate(stats) {
  const prompt = stats.input + stats.cacheRead + stats.cacheWrite;
  return prompt ? stats.cacheRead / prompt : 0;
}

function group(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

const blank = () => ({ calls: 0, failed: 0, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const positive = value => (Number.isFinite(value) && value > 0 ? value : 0);
const validLatency = value => Number.isFinite(value) && value >= 0;
const inWindow = (call, win) => Number.isFinite(call.time) && call.time >= win.start && (win.endExclusive ? call.time < win.end : call.time <= win.end);
const modelKey = call => `${call.provider}/${call.model}`;

function latencyHistogram(ttft, duration) {
  const bounds = [100, 250, 500, 1000, 2000, 5000, 10_000, 30_000];
  const bins = [...bounds, undefined].map((max, index) => ({
    min: bounds[index - 1] ?? 0, max,
    label: max === undefined ? '≥30 s' : `<${max < 1000 ? `${max} ms` : `${max / 1000} s`}`,
    ttft: 0, duration: 0,
  }));
  for (const [field, values] of [['ttft', ttft], ['duration', duration]]) {
    for (const value of values) bins.find(bin => bin.max === undefined || value < bin.max)[field]++;
  }
  return bins;
}

/** 把窗口内的调用折叠为 KPI、分桶序列（含每桶各模型用量）、模型 / 会话 / 错误分布与延迟散点。 */
function analyze(calls, win) {
  const rows = calls.filter(call => inWindow(call, win));
  const span = Math.max(0, win.end - win.start);
  const step = positive(win.step) || MIN;
  const count = Math.max(1, Math.ceil(span / step));
  const series = Array.from({ length: count }, (_, index) => ({
    time: win.start + index * step, span: Math.min(step, Math.max(0, span - index * step)),
    ...blank(), ttftSum: 0, ttftCount: 0, models: {},
  }));
  const kpi = { ...blank(), reasoning: 0 };
  const models = new Map();
  const sessions = new Map();
  const errors = new Map();
  const ttft = [];
  const duration = [];
  const points = [];
  for (const call of rows) {
    const bucket = series[Math.min(count - 1, Math.floor((call.time - win.start) / step))];
    const key = modelKey(call);
    const model = group(models, key, () => ({ key, provider: call.provider, model: call.model, ...blank(), ttft: [], duration: [] }));
    const session = group(sessions, call.session, () => ({ id: call.session, ...blank() }));
    for (const target of [bucket, kpi, model, session]) {
      target.calls++;
      if (!call.ok) target.failed++;
      for (const field of SUMMED) target[field] += positive(call[field]);
    }
    bucket.models[key] = (bucket.models[key] ?? 0) + positive(call.total);
    kpi.reasoning += positive(call.reasoning);
    if (!call.ok) {
      const error = group(errors, call.code ?? call.finish, () => ({ code: call.code ?? call.finish, count: 0, last: undefined }));
      error.count++;
      error.last = call;
      continue;
    }
    if (validLatency(call.ttft)) {
      ttft.push(call.ttft);
      model.ttft.push(call.ttft);
      bucket.ttftSum += call.ttft;
      bucket.ttftCount++;
    }
    if (validLatency(call.duration)) {
      duration.push(call.duration);
      model.duration.push(call.duration);
    }
    // 对数轴要求正值。
    if (positive(call.ttft) && positive(call.duration)) points.push({ ttft: call.ttft, duration: call.duration, key });
  }
  const minutes = span / MIN;
  return {
    rows,
    series,
    points,
    histogram: latencyHistogram(ttft, duration),
    kpi: { ...kpi, rpm: minutes ? kpi.calls / minutes : 0, tpm: minutes ? kpi.total / minutes : 0, cacheRate: cacheRate(kpi), sessions: sessions.size },
    ttft: latencyStats(ttft),
    duration: latencyStats(duration),
    models: [...models.values()].map(model => ({ ...model, ttft: latencyStats(model.ttft), duration: latencyStats(model.duration) }))
      .sort((a, b) => b.total - a.total || b.calls - a.calls),
    sessions: [...sessions.values()].sort((a, b) => b.total - a.total || b.calls - a.calls),
    errors: [...errors.values()].sort((a, b) => b.count - a.count),
  };
}

/** 前 5 个模型各自成组，其余合并为「其他」；颜色在各图之间保持一致。 */
function modelGroups(models) {
  const sorted = [...models].sort((a, b) => b.total - a.total || b.calls - a.calls);
  const groups = sorted.slice(0, PALETTE.length).map((model, index) => ({
    key: model.key, label: model.model, provider: model.provider, color: PALETTE[index], keys: [model.key],
    total: model.total, calls: model.calls, failed: model.failed,
  }));
  const rest = sorted.slice(PALETTE.length);
  if (rest.length) {
    groups.push({
      key: 'other', label: `其他 ${rest.length} 个`, provider: '', color: OTHER_COLOR, keys: rest.map(model => model.key),
      total: rest.reduce((sum, model) => sum + model.total, 0), calls: rest.reduce((sum, model) => sum + model.calls, 0),
      failed: rest.reduce((sum, model) => sum + model.failed, 0),
    });
  }
  return groups;
}

/** 52×7 热力格的 364 个时间片；「年」按本地自然日对齐，其余从现在往前等分。 */
function activityCells(calls, periodId, now) {
  const period = PERIODS.find(item => item.id === periodId) ?? PERIODS[0];
  const yearly = period.id === 'year';
  const size = period.span / HEAT_CELLS;
  const edges = Array.from({ length: HEAT_CELLS + 1 }, (_, index) => {
    if (!yearly) return index === HEAT_CELLS ? now : now - period.span + index * size;
    // 用日历加减而非固定 24 小时，避免 DST 切换使格子偏离当地零点。
    const date = new Date(startOfDay(now));
    date.setDate(date.getDate() + index - HEAT_CELLS + 1);
    return date.getTime();
  });
  const cells = edges.slice(0, -1).map((start, index) => ({ start, end: edges[index + 1], ...blank() }));
  for (const call of calls) {
    if (!Number.isFinite(call.time) || call.time < edges[0] || call.time > now) continue;
    // 以实际边界二分定位，避免等分毫秒的浮点误差把边界请求放进前一格。
    let low = 0;
    let high = HEAT_CELLS - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (call.time < edges[middle]) high = middle - 1;
      else low = middle;
    }
    const cell = cells[low];
    cell.calls++;
    if (!call.ok) cell.failed++;
    for (const field of SUMMED) cell[field] += positive(call[field]);
  }
  return cells;
}

/** 非零值在 P5–P95 之间按 log1p 分 1–5 级，0 为空格。 */
function tokenLevels(values) {
  const sorted = values.filter(value => positive(value)).sort((a, b) => a - b);
  const low = percentile(sorted, 0.05);
  const high = percentile(sorted, 0.95);
  const logLow = Math.log1p(low);
  const logSpan = Math.log1p(high) - logLow;
  return values.map(value => {
    if (!positive(value)) return 0;
    if (!(logSpan > 0)) return 5;
    const clamped = Math.min(Math.max(value, low), high);
    const ratio = (Math.log1p(clamped) - logLow) / logSpan;
    return Math.min(5, Math.max(1, 1 + Math.floor(ratio * 5)));
  });
}

/** 成功率 → 1（红）到 5（绿）；样本越多，满绿门槛越高（上限 99%）。 */
function healthLevel(ok, total) {
  if (!positive(total)) return 0;
  const rate = Math.min(positive(ok), total) / total;
  const green = Math.min(0.99, 0.9 + 0.045 * Math.max(0, Math.log10(total / 10)));
  return rate < 0.5 ? 1 : rate < 0.65 ? 2 : rate < 0.8 ? 3 : rate < green ? 4 : 5;
}

/**
 * 估算生成速率（tokens/s）：各半区间累计输出 / 累计 (duration - ttft)，不是逐调用速率均值。
 * 输出包含推理 token，不重复相加；流中的停顿也计入时间，因此不是供应商标称解码速率。
 */
function speedComparison(rows, win) {
  const models = new Map();
  const middle = win.start + (win.end - win.start) / 2;
  const sample = () => ({ tokens: 0, ms: 0, count: 0 });
  for (const call of rows) {
    if (!inWindow(call, win)) continue;
    const key = modelKey(call);
    const model = group(models, key, () => ({ key, model: call.model, provider: call.provider, before: sample(), after: sample() }));
    if (!call.ok || !positive(call.output) || !validLatency(call.ttft) || !validLatency(call.duration) || call.duration <= call.ttft) continue;
    const half = call.time < middle ? model.before : model.after;
    half.tokens += call.output;
    half.ms += call.duration - call.ttft;
    half.count++;
  }
  const rate = half => {
    const value = half.count ? (half.tokens / half.ms) * SEC : undefined;
    return Number.isFinite(value) ? value : undefined;
  };
  return [...models.values()].map(model => ({
    key: model.key, model: model.model, provider: model.provider,
    before: rate(model.before), after: rate(model.after), beforeCount: model.before.count, afterCount: model.after.count,
  }));
}

/** 会话 × 模型 Token 矩阵；保留传入会话的完整顺序，其他组接纳未显式列出的模型。 */
function sessionMatrix(rows, sessions, groups) {
  const values = sessions.map(session => ({
    id: typeof session === 'string' ? session : session.id, total: 0, calls: 0, values: groups.map(() => 0),
  }));
  const bySession = new Map(values.map(row => [row.id, row]));
  const columns = new Map();
  groups.forEach((item, index) => {
    for (const key of item.keys ?? [item.key]) columns.set(key, index);
  });
  const other = groups.findIndex(item => item.key === 'other');
  for (const call of rows) {
    const row = bySession.get(call.session);
    if (!row) continue;
    const tokens = positive(call.total);
    row.total += tokens;
    row.calls++;
    const index = columns.get(modelKey(call)) ?? other;
    if (index >= 0) row.values[index] += tokens;
  }
  return { columns: groups, rows: values };
}

/** 后半段均值相对前半段的变化率；前半段为 0 时无意义，返回 undefined。 */
function trend(values) {
  const half = Math.floor(values.length / 2);
  if (!half) return undefined;
  const mean = list => list.reduce((sum, value) => sum + value, 0) / list.length;
  const before = mean(values.slice(0, half));
  return before ? (mean(values.slice(-half)) - before) / before : undefined;
}

const round = value => Number(value.toFixed(2));

/** 过给定点的单调三次（Fritsch–Carlson）SVG 路径，不会在相邻点之间过冲。 */
function smoothPath(points) {
  points = points.filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (points.length === 0) return '';
  const head = `M${round(points[0][0])} ${round(points[0][1])}`;
  if (points.length === 1) return head;
  const n = points.length;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1][0] - points[i][0];
    slope[i] = dx[i] ? (points[i + 1][1] - points[i][1]) / dx[i] : 0;
  }
  const tangent = [slope[0]];
  for (let i = 1; i < n - 1; i++) tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  tangent[n - 1] = slope[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      tangent[i] = k * a * slope[i];
      tangent[i + 1] = k * b * slope[i];
    }
  }
  let path = head;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const third = dx[i] / 3;
    const controls = [x0 + third, y0 + tangent[i] * third, x1 - third, y1 - tangent[i + 1] * third];
    path += controls.every(Number.isFinite)
      ? ` C${controls.map(round).join(' ')} ${round(x1)} ${round(y1)}`
      : ` L${round(x1)} ${round(y1)}`;
  }
  return path;
}

/**
 * 缎带图几何：左侧源柱按占比切段，每段以两条三次贝塞尔连到右侧对应行的垂直中心。
 * 源柱高度受限，保证最粗的缎带不超过行高的 78%。
 */
function ribbonLayout(shares, { width, rowHeight }) {
  width = positive(width);
  rowHeight = positive(rowHeight);
  const weights = shares.map(positive);
  const maximum = weights.reduce((max, weight) => Math.max(max, weight), 0);
  const scaled = weights.map(weight => (maximum ? weight / maximum : 0));
  const total = scaled.reduce((sum, weight) => sum + weight, 0);
  const normalized = scaled.map(weight => (total ? weight / total : 0));
  const height = shares.length * rowHeight;
  const srcH = total ? Math.min(height * 0.8, rowHeight * 0.78 * total) : 0;
  const srcY = (height - srcH) / 2;
  const endX = Math.max(0, width - 3);
  const cA = width * 0.43;
  const cB = width * 0.57;
  let cumulative = 0;
  const ribbons = normalized.map((share, index) => {
    const startY = srcY + srcH * cumulative;
    const thickness = srcH * share;
    const endY = index * rowHeight + (rowHeight - thickness) / 2;
    cumulative += share;
    const [s, e, t] = [startY, endY, thickness].map(round);
    return {
      startY: s, endY: e, thickness: t,
      d: `M11 ${s} C${round(cA)} ${s} ${round(cB)} ${e} ${endX} ${e} L${endX} ${round(e + t)} C${round(cB)} ${round(e + t)} ${round(cA)} ${round(s + t)} 11 ${round(s + t)} Z`,
    };
  });
  return { height, width, srcY: round(srcY), srcH: round(srcH), endX, ribbons };
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const formatCount = value => (value < 10_000 ? Math.round(value).toLocaleString('en') : compact.format(value));
const formatRate = value => (value >= 100 ? formatCount(value) : value.toFixed(value >= 10 ? 1 : 2));
const formatPercent = value => `${(value * 100).toFixed(value >= 0.995 || value === 0 ? 0 : 1)}%`;
const formatMs = value => (value === undefined ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`);
const pad = value => String(value).padStart(2, '0');
function formatTime(time, step) {
  const date = new Date(time);
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (step === undefined) return `${day} ${clock}:${pad(date.getSeconds())}`;
  if (step < MIN) return `${clock}:${pad(date.getSeconds())}`;
  return step >= DAY ? day : step >= 6 * HOUR ? `${day} ${clock}` : clock;
}

module.exports = {
  MIN, HOUR, DAY, USAGE_ROUTE, RANGES, PERIODS, HEAT_CELLS, TOKEN_PARTS, PALETTE, OTHER_COLOR,
  rangeWindow, percentile, cacheRate, analyze, modelGroups, activityCells, tokenLevels, healthLevel,
  speedComparison, sessionMatrix, trend, smoothPath, ribbonLayout,
  formatCount, formatRate, formatPercent, formatMs, formatTime,
};
