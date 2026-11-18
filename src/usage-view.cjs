/**
 * 单页使用分析：光晕 KPI、活动热力格、流量 / 构成 / 诊断图和请求明细，不拆页签。
 * 聚合与几何见 usage-data.cjs，SVG 图表见 usage-charts.cjs，浏览器轮询见 usage-runtime.cjs。
 * 使用宿主 React 与主题令牌；不引入依赖、不请求外部资源、不计算费用。
 */
'use strict';

const dataHelpers = require('./usage-data.cjs');
const { createCharts } = require('./usage-charts.cjs');
const { usageStyles } = require('./usage-styles.cjs');
const { startUsagePolling, readPreference, savePreference } = require('./usage-runtime.cjs');
const {
  MIN, RANGES, PERIODS, rangeWindow, analyze, cacheRate, modelGroups, activityCells, tokenLevels, healthLevel,
  smoothPath, formatCount, formatRate, formatPercent, formatMs, formatTime,
} = dataHelpers;

const TOKEN_HEAT = ['var(--dsw-alias-border-l1)', ...[1, 2, 3, 4, 5].map(level => `var(--auralis-usage-heat-${level})`)];
const HEALTH_HEAT = ['var(--dsw-alias-border-l1)', '#ef4444', '#f97316', '#facc15', '#84cc16', '#22c55e'];
// 访问 localStorage 的 getter 也可能抛错，放在 runtime 的 I/O 边界内调用。
const preferences = {
  getItem: key => globalThis.localStorage?.getItem(key),
  setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
};

function createUsageView(React) {
  const h = React.createElement;
  const { useEffect, useMemo, useState, useRef, useId } = React;
  const charts = createCharts(React);

  function UsageIcon({ size = 16 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M4 20h16 M7 17v-4 M12 17v-6 M17 17v-3 m-13-5 5-4 4 3 7-5' }));
  }

  function Sparkline({ values, color }) {
    const gradient = `spark-${useId().replace(/[^\w-]/g, '')}`;
    const series = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
    const max = Math.max(...series) || 1;
    const points = series.map((value, index) => [2 + (index / (series.length - 1)) * 196, 38 - (value / max) * 33]);
    const path = smoothPath(points);
    return h('svg', { className: 'auralis-usage-spark', viewBox: '0 0 200 42', preserveAspectRatio: 'none', 'aria-hidden': true },
      h('defs', null, h('linearGradient', { id: gradient, x1: 0, y1: 0, x2: 0, y2: 1 },
        h('stop', { offset: '0%', stopColor: color, stopOpacity: 0.25 }), h('stop', { offset: '100%', stopColor: color, stopOpacity: 0.01 }))),
      h('path', { d: `${path} L198 42 L2 42 Z`, fill: `url(#${gradient})` }),
      h('path', { d: path, fill: 'none', stroke: color, strokeWidth: 1.7, vectorEffect: 'non-scaling-stroke' }));
  }

  function Kpi({ label, value, sub, color, values, icon }) {
    return h('div', { className: 'auralis-usage-card auralis-usage-kpi', style: { '--c': color } },
      h('div', { className: 'auralis-usage-kpi-label' }, label, h('span', { className: 'auralis-usage-kpi-icon', 'aria-hidden': true },
        h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: icon })))),
      h('div', { className: 'auralis-usage-kpi-value' }, value), h('div', { className: 'auralis-usage-kpi-sub' }, sub), h(Sparkline, { values, color }));
  }

  function Segments({ label, items, value, onChange }) {
    return h('div', { className: 'auralis-usage-seg', role: 'group', 'aria-label': label }, items.map(item =>
      h('button', { key: item.id, type: 'button', 'aria-pressed': value === item.id, onClick: () => onChange(item.id) }, item.label)));
  }

  function Heatmap({ cells, health }) {
    const [focus, setFocus] = useState(cells.length - 1);
    const [hover, setHover] = useState();
    const grid = useRef(null);
    const colors = health ? HEALTH_HEAT : TOKEN_HEAT;
    const levels = health ? cells.map(cell => healthLevel(cell.calls - cell.failed, cell.calls)) : tokenLevels(cells.map(cell => cell.total));
    const totals = cells.reduce((sum, cell) => ({ total: sum.total + cell.total, calls: sum.calls + cell.calls, failed: sum.failed + cell.failed }), { total: 0, calls: 0, failed: 0 });
    const details = index => {
      const cell = cells[index];
      return `${formatTime(cell.start)} – ${formatTime(cell.end)} · ${formatCount(cell.total)} tokens · ${cell.calls} 次调用 · ${cell.failed} 次失败`;
    };
    function navigate(event, index) {
      const delta = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
      if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? cells.length - 1 : Math.max(0, Math.min(cells.length - 1, index + delta));
      setHover(undefined);
      setFocus(next);
      grid.current?.children[next]?.focus();
    }
    return h('section', { className: 'auralis-usage-card' },
      h('h2', null, health ? '服务健康' : 'Token 活动', h('small', null, '52 × 7 时间格')),
      h('div', { className: 'auralis-usage-heat-summary' },
        h('strong', null, health ? (totals.calls ? formatPercent((totals.calls - totals.failed) / totals.calls) : '—') : formatCount(totals.total)),
        h('span', null, health ? `${totals.calls - totals.failed} 成功 / ${totals.failed} 失败` : `${totals.calls} 次调用`)),
      h('div', { className: 'auralis-usage-heat-scroll' }, h('div', { className: 'auralis-usage-heat', ref: grid, role: 'group', 'aria-label': health ? '服务健康时间格' : 'Token 活动时间格' },
        cells.map((cell, index) => h('button', {
          key: index, type: 'button', tabIndex: focus === index ? 0 : -1, style: { '--cell': colors[levels[index]] },
          title: details(index), 'aria-label': details(index),
          onMouseEnter: () => setHover(index), onMouseLeave: () => setHover(undefined),
          onFocus: () => { setHover(undefined); setFocus(index); }, onClick: () => { setFocus(index); setHover(index); }, onKeyDown: event => navigate(event, index),
        })))),
      h('div', { className: 'auralis-usage-heat-key', 'aria-hidden': true }, health ? '失败多' : '少',
        colors.map((color, index) => h('i', { key: index, style: { '--cell': color } })), health ? '健康' : '多'),
      h('p', { className: 'auralis-usage-heat-detail' }, details(hover ?? focus)));
  }

  function Activity({ calls, now, period, onPeriod }) {
    const cells = useMemo(() => activityCells(calls, period, now), [calls, period, now]);
    return h('div', null,
      h('div', { className: 'auralis-usage-section-head' },
        h('h2', null, h('span', null, '01'), '活动脉络'),
        h(Segments, { label: '活动热力图周期', items: PERIODS, value: period, onChange: onPeriod })),
      h('p', { className: 'auralis-usage-note' }, `热力图使用独立周期，不随顶部范围变化 · ${formatTime(cells[0].start)} – ${formatTime(Math.min(cells.at(-1).end, now))} · 灰格表示无调用`),
      h('div', { className: 'auralis-usage-grid' }, h(Heatmap, { cells }), h(Heatmap, { cells, health: true })));
  }

  function Sessions({ sessions, lookup }) {
    const top = sessions.slice(0, 10);
    const max = top[0]?.total || 1;
    return h('section', { className: 'auralis-usage-card' }, h('h2', null, '会话排行', h('small', null, `共 ${sessions.length} 个会话 · 前 10`)),
      !top.length ? h('div', { className: 'auralis-usage-empty' }, '该范围没有会话调用') : h('div', { className: 'auralis-usage-rank' }, top.map(session => {
        const info = lookup.get(session.id);
        return h('div', { key: session.id, className: 'auralis-usage-rank-row', title: `${info?.cwd ?? ''}\n${session.id}` },
          h('span', null, info?.title ?? session.id.slice(0, 18), info?.subagent ? h('span', { className: 'auralis-usage-tag' }, '子代理') : null),
          h('span', { className: 'auralis-usage-dim' }, `${formatCount(session.total)} · ${session.calls} 次`),
          h('div', { className: 'auralis-usage-meter' }, h('span', { style: { width: `${(session.total / max) * 100}%` } })));
      })));
  }

  function Errors({ errors, failed, calls }) {
    return h('section', { className: 'auralis-usage-card' }, h('h2', null, '失败与重试', h('small', null, `失败 ${failed} / ${calls} 次`)),
      !errors.length ? h('div', { className: 'auralis-usage-empty' }, calls ? '没有失败调用' : '该范围没有模型调用') : h('ul', { className: 'auralis-usage-errors' }, errors.map(error =>
        h('li', { key: error.code },
          h('span', null, h('span', { className: 'auralis-usage-badge', 'data-bad': true }, error.code)),
          h('span', { className: 'auralis-usage-dim' }, `${error.count} 次 · 最近 ${formatTime(error.last.time)}`),
          error.last.error ? h('p', null, error.last.error) : null))));
  }

  function Events({ rows, lookup }) {
    const [model, setModel] = useState('');
    const [status, setStatus] = useState('all');
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState(100);
    const models = useMemo(() => [...new Set(rows.map(row => `${row.provider}/${row.model}`))].sort(), [rows]);
    const filtered = useMemo(() => {
      const needle = query.trim().toLowerCase();
      return rows.filter(row => (!model || `${row.provider}/${row.model}` === model)
        && (status === 'all' || (status === 'ok') === row.ok)
        && (!needle || `${lookup.get(row.session)?.title ?? ''} ${row.session}`.toLowerCase().includes(needle))).sort((a, b) => b.time - a.time);
    }, [rows, model, status, query, lookup]);
    const change = setter => event => { setter(event.target.value); setLimit(100); };
    const cell = (value, title) => h('td', { className: 'auralis-usage-num', title }, value);
    return h('section', { className: 'auralis-usage-card' },
      h('h2', null, '请求明细', h('small', null, `${filtered.length} / ${rows.length} 条`)),
      h('div', { className: 'auralis-usage-filters' },
        h('select', { 'aria-label': '按模型筛选', value: model, onChange: change(setModel) },
          h('option', { value: '' }, '全部模型'), [...new Set([...models, ...(model ? [model] : [])])].map(name => h('option', { key: name, value: name }, name))),
        h('select', { 'aria-label': '按状态筛选', value: status, onChange: change(setStatus) },
          h('option', { value: 'all' }, '全部状态'), h('option', { value: 'ok' }, '成功'), h('option', { value: 'failed' }, '失败')),
        h('input', { type: 'search', 'aria-label': '按会话搜索', placeholder: '搜索会话标题或 id', value: query, onChange: change(setQuery) })),
      !filtered.length ? h('div', { className: 'auralis-usage-empty' }, '没有符合筛选条件的调用') : h('div', { className: 'auralis-usage-scroll' }, h('table', { className: 'auralis-usage-table' },
        h('thead', null, h('tr', null, ['时间', '会话', '模型', '输入', '缓存读', '缓存写', '输出', '总计', '首字', '耗时', '状态'].map((label, index) =>
          h('th', { key: label, scope: 'col', className: index > 2 && index < 10 ? 'auralis-usage-num' : undefined }, label)))),
        h('tbody', null, filtered.slice(0, limit).map((row, index) => {
          const info = lookup.get(row.session);
          return h('tr', { key: `${row.session}-${row.time}-${row.turn}-${row.step}-${index}` },
            h('td', { className: 'auralis-usage-dim' }, formatTime(row.time)),
            h('td', { title: `${info?.title ?? ''}\n${row.session} · 第 ${row.turn} 轮第 ${row.step} 步` },
              h('span', { className: 'auralis-usage-clip' }, info?.title ?? row.session.slice(0, 18)), info?.subagent ? h('span', { className: 'auralis-usage-tag' }, '子代理') : null),
            h('td', { title: row.provider }, row.model, row.effort ? h('span', { className: 'auralis-usage-dim' }, ` · ${row.effort}`) : null),
            cell(formatCount(row.input)), cell(formatCount(row.cacheRead)), cell(formatCount(row.cacheWrite)),
            cell(formatCount(row.output), row.reasoning ? `推理 ${row.reasoning}` : undefined), cell(formatCount(row.total)),
            cell(formatMs(row.ttft)), cell(formatMs(row.duration)),
            h('td', { title: row.error }, row.ok ? h('span', { className: 'auralis-usage-badge' }, row.finish === 'tool-calls' ? '工具调用' : row.finish === 'max-tokens' ? '达到上限' : '完成')
              : h('span', { className: 'auralis-usage-badge', 'data-bad': true }, row.code ?? row.finish)));
        })))),
      filtered.length > limit ? h('div', { className: 'auralis-usage-more' }, h('button', { type: 'button', className: 'auralis-usage-btn', onClick: () => setLimit(limit + 200) }, `显示更多（剩余 ${filtered.length - limit}）`)) : null);
  }

  function Dashboard({ data, range, period, onPeriod, prefix }) {
    const win = useMemo(() => rangeWindow(range, data.generatedAt, data.calls[0]?.time), [data, range]);
    const stats = useMemo(() => analyze(data.calls, win), [data, win]);
    const groups = useMemo(() => modelGroups(stats.models), [stats]);
    const matrixGroups = useMemo(() => stats.models.map(model => ({
      key: model.key, keys: [model.key], label: model.model, provider: model.provider,
      color: groups.find(group => group.keys.includes(model.key)).color,
    })), [stats, groups]);
    const lookup = useMemo(() => new Map(data.sessions.map(session => [session.id, session])), [data]);
    const { kpi, series } = stats;
    const values = key => series.map(bucket => bucket[key]);
    const rates = key => series.map(bucket => bucket.span > 0 ? bucket[key] * MIN / bucket.span : 0);
    const heading = (index, title, note) => h('div', { className: 'auralis-usage-section-head' }, h('h2', null, h('span', null, index), title), note ? h('p', null, note) : null);
    const section = (id, ...children) => h('section', { id: `${prefix}-${id}`, className: 'auralis-usage-section' }, ...children);
    const timeline = { series, step: win.step, kpi, rows: stats.rows, win };
    return h('div', null,
      section('overview', h('div', { className: 'auralis-usage-kpis' },
        h(Kpi, { label: '请求数', value: formatCount(kpi.calls), sub: `成功率 ${kpi.calls ? formatPercent((kpi.calls - kpi.failed) / kpi.calls) : '—'} · 失败 ${kpi.failed}`, color: '#3b82f6', values: values('calls'), icon: 'M4 7h16 M4 12h10 M4 17h13' }),
        h(Kpi, { label: 'Token 总量', value: formatCount(kpi.total), sub: `输入 ${formatCount(kpi.input)} · 输出 ${formatCount(kpi.output)}`, color: '#8b5cf6', values: values('total'), icon: 'm12 3 9 5-9 5-9-5 9-5 M3 12l9 5 9-5 M3 16l9 5 9-5' }),
        h(Kpi, { label: '平均 RPM', value: formatRate(kpi.rpm), sub: `${kpi.sessions} 个有调用的会话`, color: '#22c55e', values: rates('calls'), icon: 'M3 12h4l3-7 4 14 3-7h4' }),
        h(Kpi, { label: '平均 TPM', value: formatRate(kpi.tpm), sub: `推理 ${formatCount(kpi.reasoning)} · 已含于输出`, color: '#f97316', values: rates('total'), icon: 'm13 2-9 12h7l-1 8 10-12h-7l0-8' }),
        h(Kpi, { label: '缓存命中率', value: formatPercent(kpi.cacheRate), sub: `缓存读 ${formatCount(kpi.cacheRead)} · 写 ${formatCount(kpi.cacheWrite)}`, color: '#14b8a6', values: series.map(cacheRate), icon: 'M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 14-2 M19 16a8 8 0 0 1-14 2' }),
        h(Kpi, { label: '首字延迟 P50', value: formatMs(stats.ttft.p50), sub: `P95 ${formatMs(stats.ttft.p95)} · 耗时 P50 ${formatMs(stats.duration.p50)}`, color: '#0ea5e9', values: series.map(bucket => bucket.ttftCount ? bucket.ttftSum / bucket.ttftCount : 0), icon: 'M9 2h6 M12 7v5l3 2 M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0' }))),
      section('activity', h(Activity, { calls: data.calls, now: data.generatedAt, period, onPeriod })),
      section('traffic', heading('02', '流量与用量', '除活动热力图外，以下图表均使用顶部时间范围'),
        h('div', { className: 'auralis-usage-grid' }, h(charts.Throughput, timeline), h(charts.Results, timeline)),
        h('div', { className: 'auralis-usage-wide' }, h(charts.ModelArea, { series, step: win.step, groups })),
        h(charts.TokenBars, timeline)),
      section('composition', heading('03', '构成与分流'),
        h('div', { className: 'auralis-usage-grid' }, h(charts.TokenDonut, { kpi }), h(charts.Ribbons, { groups, total: kpi.total })),
        h('div', { className: 'auralis-usage-grid' },
          h(charts.Models, { models: stats.models, groups, total: kpi.total }),
          h(charts.Matrix, { rows: stats.rows, sessions: stats.sessions, groups: matrixGroups, lookup }))),
      section('diagnostics', heading('04', '延迟与效率'),
        h('div', { className: 'auralis-usage-grid' }, h(charts.Latency, stats), h(charts.Speed, { rows: stats.rows, win }))),
      section('requests', heading('05', '会话与请求'),
        h('div', { className: 'auralis-usage-grid' }, h(Sessions, { sessions: stats.sessions, lookup }), h(Errors, { errors: stats.errors, failed: kpi.failed, calls: kpi.calls })),
        h(Events, { key: range, rows: stats.rows, lookup })),
      h('p', { className: 'auralis-usage-footer' }, '仅统计已记录调用；推理 Token 已含于输出，不重复计数。'));
  }

  function UsagePage() {
    const [data, setData] = useState();
    const [error, setError] = useState();
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState();
    const [range, setRange] = useState(() => readPreference(preferences, 'auralis.usage.range', '24h', RANGES.map(item => item.id)));
    const [period, setPeriod] = useState(() => readPreference(preferences, 'auralis.usage.period', 'week', PERIODS.map(item => item.id)));
    const polling = useRef(null);
    const prefix = `auralis-usage-${useId().replace(/[^\w-]/g, '')}`;
    const live = RANGES.find(item => item.id === range)?.live === true;
    const interval = live ? 10_000 : 60_000;
    useEffect(() => {
      const current = startUsagePolling({ interval, onData: setData, onError: setError, onLoading: setLoading });
      polling.current = current;
      return () => { current.stop(); polling.current = null; };
    }, [interval]);
    function selectRange(value) {
      setRange(value);
      setNotice(savePreference(preferences, 'auralis.usage.range', value));
    }
    function selectPeriod(value) {
      setPeriod(value);
      setNotice(savePreference(preferences, 'auralis.usage.period', value));
    }
    return h('div', { className: 'auralis-usage-page', tabIndex: 0, role: 'region', 'aria-label': '使用分析' },
      h('style', null, usageStyles),
      h('header', { className: 'auralis-usage-head' },
        h('div', null, h('div', { className: 'auralis-usage-eyebrow' }, h('i', { className: 'auralis-usage-status-dot', 'aria-hidden': true }), 'AURALIS / USAGE OBSERVATORY'),
          h('h1', null, '使用分析'),
          h('p', null, data ? `${data.sessions.length} 个会话 · ${formatCount(data.calls.length)} 次累计调用 · 更新于 ${formatTime(data.generatedAt)}` : '正在汇总会话日志…')),
        h('div', { className: 'auralis-usage-tools' },
          h(Segments, { label: '时间范围', items: RANGES, value: range, onChange: selectRange }),
          h('button', { type: 'button', className: 'auralis-usage-btn', disabled: loading, onClick: () => polling.current?.refresh() }, loading ? '刷新中…' : '刷新'))),
      h('nav', { className: 'auralis-usage-jumps', 'aria-label': '页内分区' },
        [['overview', '总览'], ['activity', '活动'], ['traffic', '流量'], ['composition', '构成'], ['diagnostics', '诊断'], ['requests', '明细']].map(([id, label]) =>
          h('a', { key: id, href: `#${prefix}-${id}`, onClick: event => { event.preventDefault(); document.getElementById(`${prefix}-${id}`)?.scrollIntoView({ block: 'start' }); } }, label)),
        h('span', { className: 'auralis-usage-dim' }, `${interval / 1000} 秒自动刷新 · 隐藏时暂停`)),
      error ? h('div', { className: 'auralis-usage-alert', role: 'alert' }, `读取使用数据失败：${error}${data ? '；保留上次快照，稍后自动重试。' : ''}`) : null,
      notice ? h('p', { className: 'auralis-usage-note', role: 'status' }, notice) : null,
      data?.skipped.length ? h('details', { className: 'auralis-usage-alert' },
        h('summary', null, `${data.skipped.length} 个会话无法读取，当前统计不含这些会话。`),
        h('ul', null, data.skipped.map(session => h('li', { key: session.id }, `${session.id}：${session.reason}`)))) : null,
      data ? h(Dashboard, { data, range, period, onPeriod: selectPeriod, prefix }) : null);
  }

  return { UsagePage, UsageIcon, Dashboard, Activity, Heatmap, Sparkline, TokenBars: charts.TokenBars };
}

module.exports = { ...dataHelpers, usageStyles, createUsageView };
