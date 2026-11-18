/**
 * 使用分析的手写 SVG / CSS 图表。createCharts 注入宿主 React；统计与几何复用 usage-data。
 * 图表交互只保存在组件内，分桶、分组与原始调用均不修改；不依赖图表库或外部素材。
 */
'use strict';

const {
  MIN, TOKEN_PARTS, cacheRate, percentile, trend, smoothPath, ribbonLayout, speedComparison, sessionMatrix,
  formatCount, formatRate, formatPercent, formatMs, formatTime,
} = require('./usage-data.cjs');

const DEFAULT_PLOT = { width: 640, height: 260, left: 62, right: 578, top: 30, bottom: 214 };
const BLUE = 'var(--auralis-usage-chart-blue, #3b82f6)';
const ORANGE = 'var(--auralis-usage-chart-orange, #f97316)';
const SUCCESS = '#22a06b';
const FAILURE = '#e15d64';
const INK = 'var(--dsw-alias-label-secondary)';
const GRID = 'var(--dsw-alias-border-l1)';
const SURFACE = 'var(--dsw-alias-bg-layer-1)';
const positive = value => Number.isFinite(value) && value > 0 ? value : 0;
const sum = values => values.reduce((total, value) => total + value, 0);
const maxValue = values => values.reduce((max, value) => Math.max(max, positive(value)), 0);
const xy = point => `${point[0].toFixed(2)} ${point[1].toFixed(2)}`;
const linear = points => points.length ? `M${points.map(xy).join(' L')}` : '';
const plotX = (plot, index, count) => plot.left + (index + 0.5) * (plot.right - plot.left) / Math.max(1, count);
const tokens = bucket => sum(TOKEN_PARTS.map(part => positive(bucket[part.key])));
const modelKey = model => model.key ?? `${model.provider}/${model.model}`;
const rate = (value, bucket, step) => positive(bucket.span ?? step) ? positive(value) * MIN / (bucket.span ?? step) : 0;
const rateLabel = value => value > 0 && value < 0.1 ? (value < 0.001 ? value.toExponential(1) : String(Number(value.toPrecision(2)))) : formatRate(value);
const trendLabel = value => value === undefined ? '无可比基线' : `${value >= 0 ? '+' : '−'}${formatPercent(Math.abs(value))}`;

// 每层边界共享同一 smoothstep 插值权重，层间厚度是端点厚度的凸组合，不会穿层或产生负面积。
function sharedCurve(points) {
  if (!points.length) return '';
  let path = `M${xy(points[0])}`;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    const third = (b[0] - a[0]) / 3;
    path += ` C${xy([a[0] + third, a[1]])} ${xy([b[0] - third, b[1]])} ${xy(b)}`;
  }
  return path;
}

function areaPath(top, bottom, plot) {
  if (top.length === 1) {
    const x = top[0][0];
    const half = (plot.right - plot.left) / 4;
    return `M${xy([x - half, top[0][1]])} L${xy([x + half, top[0][1]])} L${xy([x + half, bottom[0][1]])} L${xy([x - half, bottom[0][1]])} Z`;
  }
  return `${sharedCurve(top)} ${sharedCurve([...bottom].reverse()).replace(/^M/, 'L')} Z`;
}

function sectorPath(start, end, outer = 82, inner = 61) {
  const gap = Math.min(0.035, (end - start) / 5);
  const a = start + gap / 2;
  const b = end - gap / 2;
  const corner = Math.min(3, (b - a) * inner / 4);
  const outStep = corner / outer;
  const inStep = corner / inner;
  const point = (radius, angle) => xy([110 + Math.cos(angle) * radius, 110 + Math.sin(angle) * radius]);
  const large = b - a - 2 * outStep > Math.PI ? 1 : 0;
  const innerLarge = b - a - 2 * inStep > Math.PI ? 1 : 0;
  return `M${point(outer, a + outStep)} A${outer} ${outer} 0 ${large} 1 ${point(outer, b - outStep)}`
    + ` Q${point(outer, b)} ${point(outer - corner, b)} L${point(inner + corner, b)}`
    + ` Q${point(inner, b)} ${point(inner, b - inStep)} A${inner} ${inner} 0 ${innerLarge} 0 ${point(inner, a + inStep)}`
    + ` Q${point(inner, a)} ${point(inner + corner, a)} L${point(outer - corner, a)} Q${point(outer, a)} ${point(outer, a + outStep)} Z`;
}

function createCharts(React) {
  const h = React.createElement;
  const { useId, useMemo, useState, useEffect } = React;

  /** 按 HTML 图表容器的实际视口重算坐标，轴边距和字号不随卡片宽度缩放。 */
  function usePlot() {
    const [element, setElement] = useState(null);
    const [plot, setPlot] = useState(DEFAULT_PLOT);
    useEffect(() => {
      if (!element) return;
      let disposed = false;
      const measure = box => {
        const { width, height } = box;
        if (disposed || !Number.isFinite(width) || !Number.isFinite(height) || width <= 124 || height <= 76) return;
        setPlot(previous => previous.width === width && previous.height === height ? previous : {
          width, height, left: 62, right: width - 62, top: 30, bottom: height - 46,
        });
      };
      measure(element.getBoundingClientRect());
      const observer = new ResizeObserver(entries => measure(entries[0].contentRect));
      observer.observe(element);
      return () => { disposed = true; observer.disconnect(); };
    }, [element]);
    return {
      plot, ref: setElement,
      xAt: (index, count) => plotX(plot, index, count),
      yAt: (value, max) => plot.bottom - positive(value) / (max || 1) * (plot.bottom - plot.top),
    };
  }
  const uid = prefix => `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const empty = message => h('div', { className: 'auralis-usage-empty' }, message ?? '该时间范围内没有模型调用');
  const note = value => value ? h('p', { className: 'auralis-usage-note' }, value) : null;
  const swatch = (color, dashed = false) => h('i', { className: `auralis-usage-swatch${dashed ? ' auralis-usage-swatch-line' : ''}`, style: { '--c': color }, 'aria-hidden': true });
  const card = (title, subtitle, body, summary) => h('section', { className: 'auralis-usage-card' },
    h('h2', null, title, subtitle ? h('small', null, subtitle) : null), ...(Array.isArray(body) ? body : [body]), note(summary));
  const svg = (label, children, { plot, ref }) => h('div', { className: 'auralis-usage-chart-frame', ref },
    h('svg', { className: 'auralis-usage-chart', viewBox: `0 0 ${plot.width} ${plot.height}`, role: 'group', 'aria-label': label }, h('title', null, label), ...children));
  const legend = items => h('div', { className: 'auralis-usage-legend' }, items.map(item => h('span', { key: item.label },
    swatch(item.color, item.dashed), item.label, item.value === undefined ? null : h('b', null, ` ${item.value}`))));
  const gradient = (id, color, light = color, opacity = 1) => h('linearGradient', { id, key: id, x1: '0', y1: '0', x2: '0', y2: '1' },
    h('stop', { offset: '0%', stopColor: light, stopOpacity: opacity }), h('stop', { offset: '100%', stopColor: color, stopOpacity: opacity * 0.64 }));

  function axes({ plot, series = [], step, max = 1, left = 'Tokens', leftFormat = formatCount, right, rightMax = 1, rightFormat = formatRate, percent = false }) {
    const count = series.length;
    const indices = [...new Set([0, Math.floor((count - 1) / 2), count - 1])].filter(index => index >= 0);
    return h('g', { className: 'auralis-usage-chart-axis', fill: INK, fontSize: 11 },
      [0, 0.25, 0.5, 0.75, 1].map(fraction => {
        const y = plot.bottom - fraction * (plot.bottom - plot.top);
        return h('g', { key: fraction },
          h('line', { className: 'auralis-usage-chart-grid', x1: plot.left, y1: y, x2: plot.right, y2: y, stroke: GRID, strokeWidth: 0.65, strokeDasharray: fraction ? '3 5' : undefined }),
          h('text', { x: plot.left - 9, y: y + 4, textAnchor: 'end' }, leftFormat(max * fraction)),
          right ? h('text', { x: plot.right + 9, y: y + 4 }, percent ? `${Math.round(fraction * 100)}%` : rightFormat(rightMax * fraction)) : null);
      }),
      h('text', { x: plot.left, y: 14 }, `左轴 · ${left}`),
      right ? h('text', { x: plot.right, y: 14, textAnchor: 'end' }, `右轴 · ${right}`) : null,
      indices.map(index => h('text', { key: index, x: plotX(plot, index, count), y: plot.bottom + 22, textAnchor: 'middle' }, formatTime(series[index].time, step))));
  }

  function tooltip(lines, x, y, width) {
    const height = lines.length * 17 + 16;
    return h('g', { className: 'auralis-usage-chart-tooltip', pointerEvents: 'none', 'aria-hidden': true },
      h('rect', { x, y, width, height, rx: 7, fill: SURFACE, stroke: GRID }),
      h('foreignObject', { x: x + 8, y: y + 8, width: width - 16, height: height - 16 },
        h('div', { style: { fontSize: 11, lineHeight: '17px', color: INK } }, lines.map((line, index) =>
          h('div', { key: index, style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, line)))));
  }

  function hoverLayer(plot, series, step, active, setActive, describe) {
    const xAt = (index, count) => plotX(plot, index, count);
    const width = (plot.right - plot.left) / Math.max(1, series.length);
    const entries = active === null || !series[active] ? [] : describe(series[active], active);
    const tooltipWidth = Math.min(224, plot.right - plot.left);
    const tooltipX = Math.max(plot.left, Math.min(plot.right - tooltipWidth, xAt(active ?? 0, series.length) + 12));
    const lines = [series[active] ? formatTime(series[active].time, step) : '', ...entries];
    return h('g', null,
      series.map((bucket, index) => {
        const label = [formatTime(bucket.time, step), ...describe(bucket, index)].join('；');
        return h('g', { key: bucket.time, tabIndex: 0, role: 'img', 'aria-label': label, 'data-bucket-index': index,
          onMouseEnter: () => setActive(index), onMouseLeave: () => setActive(null), onFocus: () => setActive(index), onBlur: () => setActive(null) },
        h('title', null, label), h('rect', { x: plot.left + index * width, y: plot.top, width, height: plot.bottom - plot.top, fill: 'transparent' }));
      }),
      entries.length ? h('g', { pointerEvents: 'none', 'aria-hidden': true },
        h('line', { x1: xAt(active, series.length), x2: xAt(active, series.length), y1: plot.top, y2: plot.bottom, stroke: INK, strokeWidth: 1, strokeDasharray: '3 3' }),
        tooltip(lines, tooltipX, plot.top + 6, tooltipWidth)) : null);
  }

  function TokenBars({ series, step, kpi }) {
    const { plot, ref, xAt, yAt } = usePlot();
    const id = uid('tokens');
    const [active, setActive] = useState(null);
    const totals = series.map(tokens);
    const max = maxValue(totals) || 1;
    const callsMax = maxValue(series.map(bucket => bucket.calls)) || 1;
    const mean = series.length ? sum(totals) / series.length : 0;
    const width = (plot.right - plot.left) / Math.max(1, series.length);
    const describe = bucket => [...TOKEN_PARTS.map(part => `${part.label} ${formatCount(positive(bucket[part.key]))}`), `请求 ${formatCount(bucket.calls)}`];
    return card('Token 用量', `峰值 ${formatCount(maxValue(totals))} / 桶`, kpi.calls ? [
      svg('Token 四项堆叠柱状图，左轴 Tokens，右轴请求数', [
        h('defs', { key: 'defs' }, TOKEN_PARTS.map(part => gradient(`${id}-${part.key}`, part.color, part.light))),
        axes({ plot, series, step, max, right: '请求 / 桶', rightMax: callsMax }),
        series.map((bucket, index) => {
          let accumulated = 0;
          return h('g', { key: bucket.time }, TOKEN_PARTS.map(part => {
            const value = positive(bucket[part.key]);
            accumulated += value;
            const height = value / max * (plot.bottom - plot.top);
            return value ? h('rect', { key: part.key, 'data-token-part': part.key, x: plot.left + index * width + width * 0.2,
              y: yAt(accumulated, max), width: width * 0.6, height: height - Math.min(1.5, height * 0.15), rx: Math.min(2, width * 0.15), fill: `url(#${id}-${part.key})` }) : null;
          }));
        }),
        h('line', { 'data-reference': 'mean', x1: plot.left, x2: plot.right, y1: yAt(mean, max), y2: yAt(mean, max), stroke: INK, strokeWidth: 1, strokeDasharray: '3 5' }),
        h('path', { 'data-series': 'calls', d: smoothPath(series.map((bucket, index) => [xAt(index, series.length), yAt(bucket.calls, callsMax)])), fill: 'none', stroke: INK, strokeWidth: 2, strokeDasharray: '6 4' }),
        series.length === 1 ? h('circle', { 'data-series': 'calls', cx: xAt(0, 1), cy: yAt(series[0].calls, callsMax), r: 4, fill: INK }) : null,
        hoverLayer(plot, series, step, active, setActive, describe),
      ], { plot, ref }),
      legend([...TOKEN_PARTS.map(part => ({ ...part, value: formatCount(positive(kpi[part.key])) })), { label: '请求（右轴）', color: INK, dashed: true }, { label: '桶均值', color: INK, dashed: true }]),
    ] : empty());
  }

  function ModelArea({ series, step, groups }) {
    const { plot, ref, xAt, yAt } = usePlot();
    const [hidden, setHidden] = useState(() => new Set());
    const [active, setActive] = useState(null);
    const visible = groups.filter(group => !hidden.has(group.key));
    const total = sum(groups.map(group => positive(group.total)));
    const values = group => series.map(bucket => sum(group.keys.map(key => positive(bucket.models?.[key]))));
    const layers = visible.map(group => ({ ...group, values: values(group) }));
    const totals = series.map((bucket, index) => sum(layers.map(group => group.values[index])));
    const max = maxValue(totals) || 1;
    let baseline = series.map(() => 0);
    const paths = layers.map(group => {
      const top = baseline.map((value, index) => value + group.values[index]);
      const path = areaPath(top.map((value, index) => [xAt(index, series.length), yAt(value, max)]), baseline.map((value, index) => [xAt(index, series.length), yAt(value, max)]), plot);
      baseline = top;
      return h('path', { key: group.key, 'data-area-key': group.key, d: path, fill: group.color, fillOpacity: 0.55, stroke: SURFACE, strokeWidth: 1.5, strokeLinejoin: 'round' });
    });
    const toggle = key => setHidden(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    const describe = (bucket, index) => layers.map(group => `${group.label} ${formatCount(group.values[index])}`);
    return card('模型用量趋势', 'Top 5 + 其他', groups.length ? [
      visible.length ? svg('按模型分组的堆叠面积图', [axes({ plot, series, step, max }), paths, hoverLayer(plot, series, step, active, setActive, describe)], { plot, ref }) : empty('已隐藏全部模型，点击图例重新显示'),
      h('div', { className: 'auralis-usage-legend auralis-usage-area-legend' }, groups.map(group => h('button', { key: group.key, type: 'button', className: 'auralis-usage-legend-button',
        'data-model-key': group.key, 'aria-pressed': !hidden.has(group.key), onClick: () => toggle(group.key), title: `${group.provider ? `${group.provider} / ` : ''}${group.label}` },
        swatch(group.color), group.label, h('b', null, `${formatCount(group.total)} Tokens`), h('span', { className: 'auralis-usage-dim' }, total ? formatPercent(group.total / total) : '—')))),
    ] : empty());
  }

  function ring(items, total, center, caption, active, handlers, gradientId) {
    let start = -Math.PI / 2;
    return h('svg', { className: 'auralis-usage-donut', viewBox: '0 0 220 220', role: handlers ? 'group' : 'img', 'aria-label': caption },
      gradientId ? h('defs', null, items.map(item => gradient(`${gradientId}-${item.key}`, item.color, item.light))) : null,
      h('circle', { cx: 110, cy: 110, r: 71.5, fill: 'none', stroke: GRID, strokeWidth: 21 }),
      items.map(item => {
        if (!(item.total > 0) || !total) return null;
        const end = start + item.total / total * Math.PI * 2;
        const chosen = active === item.key;
        const label = `${item.label} · ${formatCount(item.total)} Tokens · ${formatPercent(item.total / total)}`;
        const middle = (start + end) / 2;
        const path = h('path', { key: item.key, 'data-sector-key': item.key, 'data-active': chosen,
          d: sectorPath(start, end), fill: gradientId ? `url(#${gradientId}-${item.key})` : item.color, opacity: active && !chosen ? 0.35 : 1,
          transform: chosen ? `translate(${xy([Math.cos(middle) * 8, Math.sin(middle) * 8])})` : undefined,
          ...(handlers ? handlers(item.key) : {}), 'aria-label': label }, h('title', null, label));
        start = end;
        return path;
      }),
      h('text', { x: 110, y: 108, textAnchor: 'middle', style: { fontSize: 24, fontWeight: 650, fill: 'var(--dsw-alias-label-primary)' } }, center),
      h('text', { x: 110, y: 132, textAnchor: 'middle', style: { fontSize: 11, fontWeight: 400, fill: INK } }, caption));
  }

  function Models({ models, groups, total }) {
    const [selected, setSelected] = useState(null);
    const [hovered, setHovered] = useState(null);
    const active = [hovered, selected].find(key => groups.some(group => group.key === key)) ?? null;
    const interact = key => ({
      onMouseEnter: () => setHovered(key), onMouseLeave: () => setHovered(null), onFocus: () => setHovered(key), onBlur: () => setHovered(null),
      onClick: () => setSelected(previous => previous === key ? null : key),
    });
    const sectors = key => ({ ...interact(key), tabIndex: 0, role: 'button', 'aria-pressed': selected === key,
      onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(previous => previous === key ? null : key); } } });
    const denominator = sum(groups.map(group => positive(group.total)));
    return card('模型分布', `${models.length} 个模型`, models.length ? [
      h('div', { className: 'auralis-usage-split' }, ring(groups, denominator, formatCount(total), 'Tokens', active, sectors),
        h('div', { className: 'auralis-usage-legend auralis-usage-model-legend' }, groups.map(group => h('button', { key: group.key, type: 'button', className: 'auralis-usage-legend-button',
          'data-model-key': group.key, 'aria-pressed': selected === group.key, 'data-active': active === group.key, ...interact(group.key) },
        swatch(group.color), group.label, h('b', null, denominator ? formatPercent(group.total / denominator) : '—'))))),
      h('div', { className: 'auralis-usage-scroll' }, h('table', { className: 'auralis-usage-table' },
        h('thead', null, h('tr', null, ['模型', '请求', 'Tokens', '成功率', '首字 P50', '耗时 P50'].map((label, index) => h('th', { key: label, className: index ? 'auralis-usage-num' : undefined, scope: 'col' }, label)))),
        h('tbody', null, models.map(model => {
          const group = groups.find(item => item.keys.includes(modelKey(model)));
          const key = group?.key ?? modelKey(model);
          return h('tr', { key: modelKey(model), className: 'auralis-usage-linked-row', 'data-active': active === key, onMouseEnter: () => setHovered(key), onMouseLeave: () => setHovered(null) },
            h('td', null, h('button', { type: 'button', className: 'auralis-usage-legend-button', 'data-model-key': key, 'aria-pressed': selected === key, ...interact(key), title: `${model.provider} / ${model.model}` },
              swatch(group?.color ?? INK), h('span', { className: 'auralis-usage-clip' }, model.model)), h('span', { className: 'auralis-usage-dim' }, ` · ${model.provider}`)),
            ...[formatCount(model.calls), formatCount(model.total), model.calls ? formatPercent((model.calls - model.failed) / model.calls) : '—', formatMs(model.ttft?.p50), formatMs(model.duration?.p50)]
              .map((value, index) => h('td', { key: index, className: 'auralis-usage-num' }, value)));
        })))),
    ] : empty());
  }

  function Throughput({ series, step, kpi, rows, win }) {
    const { plot, ref, xAt, yAt } = usePlot();
    const id = uid('throughput');
    const [active, setActive] = useState(null);
    const tpm = series.map(bucket => rate(bucket.total, bucket, step));
    const rpm = series.map(bucket => rate(bucket.calls, bucket, step));
    const windowTrend = useMemo(() => {
      if (!Array.isArray(rows) || !Number.isFinite(win?.start) || !Number.isFinite(win?.end) || win.end <= win.start) return undefined;
      const middle = win.start + (win.end - win.start) / 2;
      const halves = [{ total: 0, calls: 0, minutes: (middle - win.start) / MIN }, { total: 0, calls: 0, minutes: (win.end - middle) / MIN }];
      for (const row of rows) {
        if (!Number.isFinite(row.time) || row.time < win.start || (win.endExclusive ? row.time >= win.end : row.time > win.end)) continue;
        const half = halves[row.time < middle ? 0 : 1];
        half.total += positive(row.total);
        half.calls++;
      }
      return ['total', 'calls'].map(key => trend(halves.map(half => half[key] / half.minutes)));
    }, [rows, win]);
    const changes = windowTrend ?? [trend(tpm), trend(rpm)];
    const max = maxValue(tpm) || 1;
    const rightMax = maxValue(rpm) || 1;
    const points = tpm.map((value, index) => [xAt(index, series.length), yAt(value, max)]);
    const describe = (bucket, index) => [`Tokens/min ${rateLabel(tpm[index])}`, `请求/min ${rateLabel(rpm[index])}`];
    return card('吞吐量', 'TPM / RPM', kpi.calls ? [
      svg('吞吐量，左轴 Tokens/min，右轴请求/min', [
        h('defs', null, gradient(id, BLUE, BLUE, 0.3)), axes({ plot, series, step, max, left: 'Tokens/min', leftFormat: rateLabel, right: '请求/min', rightMax, rightFormat: rateLabel }),
        points.length ? h('path', { d: `${smoothPath(points)} L${xy([points.at(-1)[0], plot.bottom])} L${xy([points[0][0], plot.bottom])} Z`, fill: `url(#${id})` }) : null,
        h('path', { d: smoothPath(points), fill: 'none', stroke: BLUE, strokeWidth: 2 }),
        h('path', { d: smoothPath(rpm.map((value, index) => [xAt(index, series.length), yAt(value, rightMax)])), fill: 'none', stroke: ORANGE, strokeWidth: 2, strokeDasharray: '6 4' }),
        points.length === 1 ? h('g', null,
          h('circle', { 'data-series': 'calls', cx: xAt(0, 1), cy: yAt(rpm[0], rightMax), r: 6, fill: SURFACE, stroke: ORANGE, strokeWidth: 2 }),
          h('circle', { 'data-series': 'tokens', cx: points[0][0], cy: points[0][1], r: 3.5, fill: BLUE })) : null,
        hoverLayer(plot, series, step, active, setActive, describe),
      ], { plot, ref }),
      legend([{ label: 'Tokens/min（左轴）', color: BLUE }, { label: '请求/min（右轴）', color: ORANGE, dashed: true }]),
    ] : empty(), `最新 ${rateLabel(tpm.at(-1) ?? 0)} TPM / ${rateLabel(rpm.at(-1) ?? 0)} RPM · ${windowTrend ? '前后半段' : '前后半组桶均值'} ${trendLabel(changes[0])} / ${trendLabel(changes[1])}`);
  }

  function Results({ series, step, kpi }) {
    const { plot, ref, xAt, yAt } = usePlot();
    const id = uid('results');
    const [active, setActive] = useState(null);
    const max = maxValue(series.map(bucket => bucket.calls)) || 1;
    const width = (plot.right - plot.left) / Math.max(1, series.length);
    const ranges = [];
    let segment = [];
    series.forEach((bucket, index) => {
      if (bucket.calls) segment.push([xAt(index, series.length), yAt(bucket.failed / bucket.calls, 1)]);
      else if (segment.length) { ranges.push(segment); segment = []; }
    });
    if (segment.length) ranges.push(segment);
    const describe = bucket => [`成功 ${formatCount(bucket.calls - bucket.failed)}`, `失败 ${formatCount(bucket.failed)}`, `失败率 ${bucket.calls ? formatPercent(bucket.failed / bucket.calls) : '无请求'}`];
    return card('请求结果', `${formatCount(kpi.calls)} 次请求`, kpi.calls ? [
      svg('成功与失败请求柱状图及失败率，右轴固定 0 至 100%', [
        h('defs', null, gradient(`${id}-ok`, SUCCESS, '#7bdbaf'), gradient(`${id}-failed`, FAILURE, '#f4adb1')),
        axes({ plot, series, step, max, left: '请求 / 桶', right: '失败率', rightMax: 1, percent: true }),
        series.map((bucket, index) => h('g', { key: bucket.time }, [
          { key: 'ok', value: bucket.calls - bucket.failed, top: bucket.calls - bucket.failed },
          { key: 'failed', value: bucket.failed, top: bucket.calls },
        ].map(part => {
          const height = part.value / max * (plot.bottom - plot.top);
          return part.value > 0 ? h('rect', { key: part.key, x: plot.left + index * width + width * 0.22, y: yAt(part.top, max), width: width * 0.56,
            height: height - Math.min(1.5, height * 0.15), rx: 2, fill: `url(#${id}-${part.key})` }) : null;
        }))),
        ranges.map((points, index) => h('path', { key: index, 'data-series': 'failure-rate', d: linear(points), fill: 'none', stroke: ORANGE, strokeWidth: 2, strokeDasharray: '5 4' })),
        series.map((bucket, index) => bucket.calls ? h('circle', { key: bucket.time, 'data-failure-rate': bucket.failed / bucket.calls,
          cx: xAt(index, series.length), cy: yAt(bucket.failed / bucket.calls, 1), r: 3, fill: ORANGE, stroke: SURFACE, strokeWidth: 1.5 }) : null),
        hoverLayer(plot, series, step, active, setActive, describe),
      ], { plot, ref }),
      legend([{ label: '成功', color: SUCCESS, value: formatCount(kpi.calls - kpi.failed) }, { label: '失败', color: FAILURE, value: formatCount(kpi.failed) }, { label: '失败率（右轴 0–100%）', color: ORANGE, dashed: true }]),
    ] : empty());
  }

  function TokenDonut({ kpi }) {
    const id = uid('token-donut');
    const items = TOKEN_PARTS.map(part => ({ ...part, total: positive(kpi[part.key]) }));
    const total = sum(items.map(item => item.total));
    return card('Token 构成', `${formatCount(total)} Tokens`, total ? h('div', { className: 'auralis-usage-split' },
      ring(items, total, formatPercent(cacheRate(kpi)), '缓存读取 / 提示词', undefined, undefined, id),
      h('div', { className: 'auralis-usage-legend auralis-usage-token-legend' }, items.map(item => h('div', { key: item.key, className: 'auralis-usage-token-part' },
        h('div', { className: 'auralis-usage-token-part-label' }, swatch(item.color), item.label,
          h('b', null, ` ${formatCount(item.total)}`), h('span', { className: 'auralis-usage-dim' }, ` · ${formatPercent(item.total / total)}`)),
        h('div', { className: 'auralis-usage-token-progress', 'data-token-progress': item.key, 'aria-hidden': true,
          style: { height: 4, width: '100%', background: GRID, borderRadius: 2, overflow: 'hidden' } },
        h('span', { style: { display: 'block', height: '100%', width: `${item.total / total * 100}%`, borderRadius: 'inherit', background: `linear-gradient(180deg, ${item.light ?? item.color}, ${item.color})` } })))))) : empty(kpi.calls ? '这些调用没有记录 Token 用量' : undefined));
  }

  function Latency({ points }) {
    const { plot, ref } = usePlot();
    const [active, setActive] = useState(null);
    const [sample, setSample] = useState(null);
    const paired = useMemo(() => points.filter(point => point.ok !== false && Number.isFinite(point.ttft) && point.ttft > 0 && Number.isFinite(point.duration) && point.duration > 0), [points]);
    const sampled = useMemo(() => paired.length > 800 ? Array.from({ length: 800 }, (_, index) => paired[Math.floor(index * (paired.length - 1) / 799)]) : paired, [paired]);
    const stats = useMemo(() => ['ttft', 'duration'].map(key => {
      const sorted = paired.map(point => point[key]).sort((a, b) => a - b);
      const low = sorted.length ? Math.floor(Math.log10(sorted[0])) : 0;
      const high = sorted.length ? Math.max(low + 1, Math.ceil(Math.log10(sorted.at(-1)))) : 1;
      return { low, high, p95: percentile(sorted, 0.95) };
    }), [paired]);
    const [xBounds, yBounds] = stats;
    const x = value => plot.left + (Math.log10(value) - xBounds.low) / (xBounds.high - xBounds.low) * (plot.right - plot.left);
    const y = value => plot.bottom - (Math.log10(value) - yBounds.low) / (yBounds.high - yBounds.low) * (plot.bottom - plot.top);
    const ticks = bound => {
      const count = Math.min(5, bound.high - bound.low + 1);
      return Array.from({ length: count }, (_, index) => 10 ** (bound.low + index / (count - 1) * (bound.high - bound.low)));
    };
    const p95x = xBounds.p95;
    const p95y = yBounds.p95;
    const refs = paired.length ? [{ key: 'ttft', label: '首字 P95', value: p95x, x1: x(p95x), x2: x(p95x), y1: plot.top, y2: plot.bottom },
      { key: 'duration', label: '耗时 P95', value: p95y, x1: plot.left, x2: plot.right, y1: y(p95y), y2: y(p95y) }] : [];
    return card('首字延迟 × 总耗时', '双对数坐标 · 成功调用', paired.length ? [
      svg('成功调用首字延迟与总耗时散点，双对数坐标，单位为毫秒', [
        h('g', { className: 'auralis-usage-chart-axis', fill: INK, fontSize: 11 },
          ticks(xBounds).map(value => h('g', { key: value }, h('line', { x1: x(value), x2: x(value), y1: plot.top, y2: plot.bottom, stroke: GRID, strokeWidth: 0.65, strokeDasharray: '3 5' }), h('text', { x: x(value), y: plot.bottom + 20, textAnchor: 'middle' }, formatMs(value)))),
          ticks(yBounds).map(value => h('g', { key: value }, h('line', { x1: plot.left, x2: plot.right, y1: y(value), y2: y(value), stroke: GRID, strokeWidth: 0.65, strokeDasharray: '3 5' }), h('text', { x: plot.left - 9, y: y(value) + 4, textAnchor: 'end' }, formatMs(value)))),
          h('text', { x: plot.left, y: 14 }, '总耗时 · 对数'), h('text', { x: plot.right, y: plot.bottom + 39, textAnchor: 'end' }, '首字延迟 TTFT · 对数')),
        sampled.map((point, index) => h('g', { key: index, 'data-latency-sample': index, tabIndex: 0, role: 'img',
          'aria-label': `${point.key ?? '调用'}：首字 ${formatMs(point.ttft)}，总耗时 ${formatMs(point.duration)}`,
          onMouseEnter: () => setSample(point), onMouseLeave: () => setSample(null), onFocus: () => setSample(point), onBlur: () => setSample(null) },
        h('title', null, `${point.key ?? '调用'} · 首字 ${formatMs(point.ttft)} · 总耗时 ${formatMs(point.duration)}`),
        h('circle', { cx: x(point.ttft), cy: y(point.duration), r: 12, fill: 'transparent' }),
        h('circle', { cx: x(point.ttft), cy: y(point.duration), r: sample === point ? 5 : 4, fill: BLUE, fillOpacity: 0.55, stroke: SURFACE, strokeWidth: 1.5, pointerEvents: 'none' }))),
        refs.map(ref => h('g', { key: ref.key, 'data-p95-axis': ref.key, 'data-p95-value': ref.value, tabIndex: 0, role: 'img',
          'aria-label': `${ref.label} ${formatMs(ref.value)}`, onMouseEnter: () => setActive(ref.key), onMouseLeave: () => setActive(null), onFocus: () => setActive(ref.key), onBlur: () => setActive(null) },
        h('title', null, `${ref.label} ${formatMs(ref.value)}，按全部 ${formatCount(paired.length)} 个配对样本计算`),
        h('line', { x1: ref.x1, x2: ref.x2, y1: ref.y1, y2: ref.y2, stroke: 'transparent', strokeWidth: 18, pointerEvents: 'stroke' }),
        h('line', { x1: ref.x1, x2: ref.x2, y1: ref.y1, y2: ref.y2, stroke: INK, strokeWidth: active === ref.key ? 3 : 1.2, strokeDasharray: '5 5', pointerEvents: 'none' }),
        active === ref.key ? tooltip([`${ref.label} ${formatMs(ref.value)}`], plot.left, plot.top + 4, Math.min(184, plot.right - plot.left)) : null)),
        sample && !active ? tooltip([`首字 ${formatMs(sample.ttft)}`, `总耗时 ${formatMs(sample.duration)}`], plot.left, plot.top + 4, Math.min(224, plot.right - plot.left)) : null,
      ], { plot, ref }),
    ] : empty('没有同时具备正值首字延迟与总耗时的成功调用'),
    `${paired.length > sampled.length ? `抽样 ${formatCount(sampled.length)} / ${formatCount(paired.length)}` : `${formatCount(paired.length)} 个样本`} · 配对全集 P95：首字 ${formatMs(p95x)} / 耗时 ${formatMs(p95y)}`);
  }

  function Ribbons({ groups }) {
    const denominator = sum(groups.map(group => positive(group.total)));
    const layout = ribbonLayout(groups.map(group => denominator ? positive(group.total) / denominator : 0), { width: 240, rowHeight: 72 });
    return card('模型用量流向', 'Top 5 + 其他', groups.length && denominator ? h('div', { className: 'auralis-usage-ribbon-layout', style: { display: 'grid', gridTemplateColumns: '40% minmax(0, 1fr)', alignItems: 'start' } },
      h('svg', { className: 'auralis-usage-ribbon-svg', viewBox: `0 0 240 ${layout.height}`, width: '100%', height: layout.height, preserveAspectRatio: 'none', role: 'img', 'aria-label': '模型 Token 用量缎带图', style: { display: 'block', height: layout.height } },
        layout.ribbons.map((ribbon, index) => h('g', { key: groups[index].key },
          h('path', { d: ribbon.d, fill: groups[index].color, fillOpacity: 0.34, stroke: groups[index].color, strokeOpacity: 0.65, strokeWidth: 0.6 }, h('title', null, `${groups[index].label} ${formatPercent(groups[index].total / denominator)}`)),
          h('rect', { x: 4, y: ribbon.startY, width: 7, height: ribbon.thickness, rx: 2, fill: groups[index].color }),
          h('rect', { x: layout.endX - 3, y: ribbon.endY, width: 6, height: ribbon.thickness, rx: 2, fill: groups[index].color })))),
      h('div', { className: 'auralis-usage-ribbon-rows' }, groups.map(group => h('div', { key: group.key, className: 'auralis-usage-ribbon-row', style: { height: 72, display: 'grid', alignContent: 'center', gap: 5, boxSizing: 'border-box' }, title: `${group.provider ? `${group.provider} / ` : ''}${group.label}` },
        h('div', { className: 'auralis-usage-clip' }, swatch(group.color), group.label),
        h('div', { className: 'auralis-usage-dim' }, `${formatCount(group.calls)} 请求 · ${formatCount(group.total)} Tokens · ${formatPercent(group.total / denominator)}`))))) : empty(groups.length ? '这些调用没有记录 Token 用量' : undefined));
  }

  function Speed({ rows, win }) {
    const comparison = useMemo(() => speedComparison(rows, win), [rows, win]);
    const max = maxValue(comparison.flatMap(row => [row.before, row.after])) || 1;
    const value = amount => amount === undefined ? '无样本' : `${formatRate(amount)} tok/s`;
    return card('输出速度对比', '前半段 vs 后半段', comparison.length ? [
      legend([{ label: '前半段 · 空心', color: BLUE }, { label: '后半段 · 实心', color: ORANGE }]),
      h('div', { className: 'auralis-usage-scroll auralis-usage-speed' },
        h('div', { className: 'auralis-usage-speed-scale auralis-usage-dim', style: { display: 'grid', gridTemplateColumns: 'minmax(90px, 1fr) minmax(90px, 1.3fr) minmax(110px, 1fr)', gap: 12, alignItems: 'center' } },
          h('span', null, '模型'), h('span', { style: { display: 'flex', justifyContent: 'space-between' } }, h('span', null, '0'), h('span', null, `${formatRate(max)} tok/s`)), h('span', { className: 'auralis-usage-num' }, '前半段 → 后半段')),
        comparison.map(row => h('div', { key: row.key, className: 'auralis-usage-speed-row', 'data-speed-key': row.key,
        style: { display: 'grid', gridTemplateColumns: 'minmax(90px, 1fr) minmax(90px, 1.3fr) minmax(110px, 1fr)', gap: 12, alignItems: 'center', minHeight: 49 } },
      h('div', { className: 'auralis-usage-clip', title: `${row.provider} / ${row.model}` }, row.model, h('div', { className: 'auralis-usage-dim' }, row.provider)),
      h('svg', { viewBox: '0 0 240 34', style: { width: '100%', height: 34 }, role: 'img', 'aria-label': `前半段 ${value(row.before)}，后半段 ${value(row.after)}` },
        h('line', { x1: 10, x2: 230, y1: 17, y2: 17, stroke: GRID, strokeWidth: 2 }),
        row.before !== undefined && row.after !== undefined ? h('line', { x1: 10 + row.before / max * 220, x2: 10 + row.after / max * 220, y1: 17, y2: 17, stroke: INK, strokeWidth: 2 }) : null,
        row.before !== undefined ? h('circle', { cx: 10 + row.before / max * 220, cy: 17, r: 5, fill: SURFACE, stroke: BLUE, strokeWidth: 2 }, h('title', null, `前半段 ${value(row.before)} · ${row.beforeCount} 个样本`)) : null,
        row.after !== undefined ? h('circle', { cx: 10 + row.after / max * 220, cy: 17, r: 5, fill: ORANGE, stroke: SURFACE, strokeWidth: 1.5 }, h('title', null, `后半段 ${value(row.after)} · ${row.afterCount} 个样本`)) : null),
      h('div', { className: 'auralis-usage-num' }, `${value(row.before)} → ${value(row.after)}`, h('div', { className: 'auralis-usage-dim' }, `${row.beforeCount} / ${row.afterCount} 个样本`))))),
    ] : empty('没有可比较的模型调用'),
    '估算速度 = 总输出 ÷ 总生成耗时（扣除首字等待）');
  }

  function Matrix({ rows, sessions, groups, lookup }) {
    const matrix = useMemo(() => sessionMatrix(rows, sessions, groups), [rows, sessions, groups]);
    const max = maxValue(matrix.rows.flatMap(row => row.values));
    const color = value => {
      if (!(value > 0) || !max) return { background: 'transparent', color: INK };
      const strength = (value / max) ** 0.65;
      const from = [255, 232, 204];
      const to = [166, 37, 35];
      const rgb = from.map((start, index) => Math.round(start + (to[index] - start) * strength));
      const luminance = rgb.map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((value, channel, index) => value + channel * [0.2126, 0.7152, 0.0722][index], 0);
      return { background: `rgb(${rgb.join(',')})`, color: luminance < 0.179 ? '#fff' : '#000' };
    };
    return card('会话 × 模型', `${matrix.rows.length} 个会话`, matrix.rows.length && groups.length ? h('div', { className: 'auralis-usage-scroll' },
      h('table', { className: 'auralis-usage-table auralis-usage-matrix' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, '会话'), matrix.columns.map(group => h('th', { key: group.key, scope: 'col', title: `${group.provider} / ${group.label}` }, swatch(group.color), group.label)), h('th', { scope: 'col', className: 'auralis-usage-num' }, '合计'))),
        h('tbody', null, matrix.rows.map(row => {
          const info = lookup.get(row.id);
          const name = info?.title ?? row.id;
          return h('tr', { key: row.id, 'data-session-id': row.id },
            h('th', { scope: 'row', title: `${name}\n${row.id}` }, h('span', { className: 'auralis-usage-clip' }, name), h('div', { className: 'auralis-usage-dim' }, `${formatCount(row.calls)} 请求`)),
            row.values.map((value, index) => h('td', { key: matrix.columns[index].key, className: 'auralis-usage-num auralis-usage-heat-cell', 'data-heat-value': value, style: color(value),
              title: `${name} × ${matrix.columns[index].label}：${formatCount(value)} Tokens` }, value ? formatCount(value) : '—')),
            h('td', { className: 'auralis-usage-num' }, formatCount(row.total)));
        })))) : empty());
  }

  return { TokenBars, ModelArea, Models, Throughput, Results, TokenDonut, Latency, Ribbons, Speed, Matrix };
}

module.exports = { createCharts };
