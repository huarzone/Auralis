import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createUsageView, usageStyles, activityCells } = require('../src/usage-view.cjs');

function fakeReact(initial = []) {
  let id = 0;
  let state = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: value => [state < initial.length ? initial[state++] : typeof value === 'function' ? value() : value, () => {}],
    useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }), useEffect() {},
    useId: () => `test-${++id}`,
  };
}
function render(node) {
  if (Array.isArray(node)) return node.map(render);
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }));
  return { ...node, children: node.children.map(render) };
}
function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(node => find(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(node => find(node, predicate))];
}

const now = Date.UTC(2026, 10, 6, 10);
const call = {
  time: now - 20_000, session: 's', turn: 1, step: 1, model: 'model', provider: 'p',
  ok: true, finish: 'stop', input: 100, cacheRead: 20, cacheWrite: 30, output: 50, total: 200, ttft: 1000, duration: 5000,
};
const snapshot = { generatedAt: now, sessions: [{ id: 's', title: '测试会话' }], calls: [call], skipped: [] };

test('loaded dashboard keeps all agreed visualizations together without page tabs', () => {
  const { Dashboard } = createUsageView(fakeReact());
  assert.equal(typeof Dashboard, 'function');
  const tree = render(Dashboard({ data: snapshot, range: '1h', period: 'day', onPeriod() {}, prefix: 'test' }));
  const text = JSON.stringify(tree);
  for (const label of ['Token 活动', '服务健康', '模型', '吞吐', 'Token 用量', '首字', '会话', '失败与重试', '请求明细']) assert.ok(text.includes(label), label);
  assert.equal(find(tree, node => node.props.role === 'tablist').length, 0);
  const idsOfSections = find(tree, node => node.type === 'section' && node.props.id).map(node => node.props.id);
  assert.deepEqual(idsOfSections, ['test-overview', 'test-activity', 'test-traffic', 'test-composition', 'test-diagnostics', 'test-requests']);
  assert.equal(find(tree, node => node.props.className === 'auralis-usage-card auralis-usage-kpi').length, 6);
  assert.equal(find(tree, node => node.props.className === 'auralis-usage-heat').length, 2);
  assert.equal(find(tree, node => node.type === 'svg').length >= 12, true);
  const ids = find(tree, node => node.props.id).map(node => node.props.id);
  assert.equal(new Set(ids).size, ids.length, 'SVG paint servers and section anchors have unique ids');
  assert.doesNotMatch(text, /NaN|Infinity|https?:\/\//);
});

test('model distribution and session matrix share one half-width row with a narrow-screen fallback', () => {
  const { Dashboard } = createUsageView(fakeReact());
  const tree = render(Dashboard({ data: snapshot, range: '1h', period: 'day', onPeriod() {}, prefix: 'test' }));
  const pairs = find(tree, node => node.props.className === 'auralis-usage-grid').map(grid =>
    grid.children.filter(child => child?.type === 'section').map(card => card.children.find(child => child?.type === 'h2')?.children[0]));
  assert.ok(pairs.some(titles => titles.length === 2 && titles[0] === '模型分布' && titles[1] === '会话 × 模型'));
  assert.match(usageStyles, /\.auralis-usage-grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(usageStyles, /@container\(max-width:900px\)\{\.auralis-usage-grid\{grid-template-columns:minmax\(0,1fr\)/);
});

test('page and card scrollbars stay hidden without disabling scroll access or request details', () => {
  const rule = usageStyles.match(/\.auralis-usage-page\{([^}]+)\}/)[1];
  assert.match(rule, /overflow:auto/);
  assert.match(rule, /scrollbar-width:none/);
  assert.match(usageStyles, /\.auralis-usage-page::-webkit-scrollbar\{[^}]*display:none/);
  const cardScroll = usageStyles.match(/^\.auralis-usage-scroll\{([^}]+)\}/m)[1];
  assert.match(cardScroll, /overflow:auto/);
  assert.match(cardScroll, /scrollbar-width:none/);
  assert.match(usageStyles, /\.auralis-usage-scroll::-webkit-scrollbar\{[^}]*display:none/);
  assert.doesNotMatch(cardScroll, /overflow:hidden/);
  const { UsagePage, Dashboard } = createUsageView(fakeReact());
  assert.equal(UsagePage().props.tabIndex, 0, 'scroll container remains keyboard focusable');
  const tree = render(Dashboard({ data: snapshot, range: '1h', period: 'day', onPeriod() {}, prefix: 'test' }));
  assert.doesNotMatch(JSON.stringify(tree), /查看数据|auralis-usage-data-details/);
  assert.ok(find(tree, node => node.type === 'table').length >= 3, 'model, session and request tables remain');
});

test('standard chart viewport has an explicit height without a fixed-ratio height cap', () => {
  const chart = usageStyles.match(/\.auralis-usage-chart\{([^}]+)\}/)[1];
  assert.match(chart, /width:100%/);
  assert.match(chart, /(?:^|;)height:260px(?:;|$)/);
  assert.doesNotMatch(chart, /max-height|min-height|height:auto/);
});

test('empty snapshot still renders one honest dashboard without invalid SVG geometry', () => {
  const { Dashboard } = createUsageView(fakeReact());
  const tree = render(Dashboard({ data: { ...snapshot, calls: [], sessions: [] }, range: 'today', period: 'year', onPeriod() {}, prefix: 'test' }));
  assert.doesNotMatch(JSON.stringify(tree), /NaN|Infinity|https?:\/\//);
  assert.ok(find(tree, node => node.props.className === 'auralis-usage-empty').length > 0);
});

test('activity grid has a single keyboard entry point and accessible per-cell details', () => {
  const { Activity } = createUsageView(fakeReact());
  const tree = render(Activity({ calls: [call], now, period: 'day', onPeriod() {} }));
  const grids = find(tree, node => node.props.className === 'auralis-usage-heat');
  assert.equal(grids.length, 2);
  for (const grid of grids) {
    const buttons = find(grid, node => node.type === 'button');
    assert.equal(buttons.length, 364);
    assert.equal(buttons.filter(button => button.props.tabIndex === 0).length, 1);
    assert.ok(buttons.every(button => typeof button.props['aria-label'] === 'string'));
    assert.equal(typeof buttons[0].props.onKeyDown, 'function');
    const focused = [];
    grid.props.ref.current = { children: buttons.map((_, index) => ({ focus: () => focused.push(index) })) };
    let prevented = 0;
    buttons[0].props.onKeyDown({ key: 'ArrowRight', preventDefault: () => prevented++ });
    buttons[7].props.onKeyDown({ key: 'ArrowUp', preventDefault: () => prevented++ });
    buttons[6].props.onKeyDown({ key: 'End', preventDefault: () => prevented++ });
    buttons[0].props.onKeyDown({ key: 'Tab', preventDefault: () => prevented++ });
    assert.deepEqual(focused, [7, 6, 363]);
    assert.equal(prevented, 3, 'Tab remains normal page navigation');
  }
});

test('heatmap keyboard movement clears a previously clicked hover cell', () => {
  const React = fakeReact();
  const states = [];
  let cursor = 0;
  React.useState = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
  };
  const { Heatmap } = createUsageView(React);
  const cells = activityCells([call], 'day', now);
  const draw = () => { cursor = 0; return render(Heatmap({ cells })); };
  let tree = draw();
  let buttons = find(tree, node => node.type === 'button');
  buttons[363].props.onClick();
  tree = draw();
  buttons = find(tree, node => node.type === 'button');
  buttons[363].props.onKeyDown({ key: 'ArrowUp', preventDefault() {} });
  tree = draw();
  const text = find(tree, node => node.props.className === 'auralis-usage-heat-detail')[0].children.join('');
  buttons = find(tree, node => node.type === 'button');
  assert.equal(buttons[362].props.tabIndex, 0);
  assert.equal(text, buttons[362].props['aria-label']);
  assert.notEqual(text, buttons[363].props['aria-label']);
  buttons[363].props.onMouseEnter();
  tree = draw();
  find(tree, node => node.type === 'button')[5].props.onFocus();
  tree = draw();
  assert.equal(find(tree, node => node.props.className === 'auralis-usage-heat-detail')[0].children.join(''), find(tree, node => node.type === 'button')[5].props['aria-label']);
});

test('page offers all short windows and persists a selection without replacing the page with tabs', () => {
  const saved = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: (...args) => saved.push(args) } });
  try {
    const { UsagePage } = createUsageView(fakeReact());
    const tree = render(UsagePage());
    const group = find(tree, node => node.props['aria-label'] === '时间范围')[0];
    const buttons = find(group, node => node.type === 'button');
    for (const minutes of [15, 30, 60]) {
      const button = buttons.find(node => node.children.join('').includes(`${minutes} 分钟`));
      assert.ok(button, `missing ${minutes} minute window`);
      button.props.onClick();
    }
    assert.deepEqual(saved, [['auralis.usage.range', '15m'], ['auralis.usage.range', '30m'], ['auralis.usage.range', '1h']]);
    assert.equal(find(tree, node => node.props.role === 'tablist').length, 0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('all selected short windows and heatmap periods render finite empty and populated dashboards', () => {
  for (const range of ['15m', '30m', '1h', '24h', 'today', 'yesterday', '7d', '30d', 'all']) {
    for (const period of ['day', 'week', 'month', 'year']) {
      const { Dashboard } = createUsageView(fakeReact());
      const text = JSON.stringify(render(Dashboard({ data: snapshot, range, period, onPeriod() {}, prefix: 'test' })));
      assert.doesNotMatch(text, /NaN|Infinity|undefined%/, `${range}/${period}`);
    }
  }
});

test('one-page controls keep live and historical polling intervals distinct', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    for (const [range, seconds] of [['15m', 10], ['30m', 10], ['1h', 10], ['7d', 60]]) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => key.endsWith('.range') ? range : null } });
      const { UsagePage } = createUsageView(fakeReact());
      assert.ok(JSON.stringify(render(UsagePage())).includes(`${seconds} 秒自动刷新`));
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('request table keeps large histories paged and filters identical model names by provider', () => {
  const calls = Array.from({ length: 250 }, (_, index) => ({ ...call, time: call.time - index, provider: index % 2 ? 'p1' : 'p2', step: index }));
  const { Dashboard } = createUsageView(fakeReact());
  const tree = render(Dashboard({ data: { ...snapshot, calls }, range: '1h', period: 'day', onPeriod() {}, prefix: 'test' }));
  const filter = find(tree, node => node.props['aria-label'] === '按模型筛选')[0];
  assert.deepEqual(find(filter, node => node.type === 'option').map(node => node.props.value), ['', 'p1/model', 'p2/model']);
  const events = find(tree, node => node.type === 'section' && node.children.some(child => child?.type === 'h2' && child.children.includes('请求明细')))[0];
  assert.equal(find(events, node => node.type === 'tr').length, 101, '100 request rows plus one header');
  assert.match(JSON.stringify(events), /剩余 150/);
});

test('session matrix shows every model column even when trend charts group the tail', () => {
  const calls = Array.from({ length: 8 }, (_, index) => ({ ...call, model: `model-${index}`, step: index }));
  const { Dashboard } = createUsageView(fakeReact());
  const tree = render(Dashboard({ data: { ...snapshot, calls }, range: '1h', period: 'day', onPeriod() {}, prefix: 'test' }));
  const matrix = find(tree, node => node.props.className === 'auralis-usage-table auralis-usage-matrix')[0];
  const header = find(matrix, node => node.type === 'thead')[0];
  assert.equal(find(header, node => node.type === 'th').length, 10, 'eight models plus session and total');
  for (let index = 0; index < 8; index++) assert.ok(JSON.stringify(header).includes(`model-${index}`));
});

test('loaded page exposes unreadable sessions and retained-snapshot errors without hiding charts', () => {
  const partial = { ...snapshot, skipped: [{ id: 'broken', reason: 'migration-required' }] };
  const { UsagePage } = createUsageView(fakeReact([partial, 'HTTP 401', false]));
  const tree = render(UsagePage());
  const text = JSON.stringify(tree);
  assert.match(text, /保留上次快照/);
  assert.match(text, /migration-required/);
  assert.match(text, /请求明细/);
  assert.equal(find(tree, node => node.type === 'details' && node.props.className === 'auralis-usage-alert').length, 1);
});

test('single-page styles preserve responsive, reduced-motion and reduced-transparency fallbacks', () => {
  assert.match(usageStyles, /@container/);
  assert.match(usageStyles, /prefers-reduced-motion/);
  assert.match(usageStyles, /prefers-reduced-transparency/);
  assert.match(usageStyles, /grid-template-rows:repeat\(7/);
  assert.match(usageStyles, /\.auralis-usage-area-legend button\[aria-pressed=false\]/);
  assert.doesNotMatch(usageStyles, /\.auralis-usage-legend button\[aria-pressed=false\]/, 'unselected model highlights are not hidden series');
  assert.match(usageStyles, /\.auralis-usage-matrix tbody th\{position:static/);
  assert.doesNotMatch(usageStyles, /https?:\/\//);
});
