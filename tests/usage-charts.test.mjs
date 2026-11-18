import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const data = require('../src/usage-data.cjs');

// A tiny hook host exercises component-local interactions without adding a renderer dependency.
function harness() {
  let cursor = 0;
  let sequence = 0;
  const hooks = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity) }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useMemo: fn => fn(), useEffect() {},
    useId() { return `:chart-${sequence++}:`; },
  };
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return { ...node, children: node.children.map(expand) };
  }
  return {
    React,
    render(component, props) { cursor = 0; return expand(component(props)); },
  };
}

function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => nodes(child, predicate))];
}
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(text).join(' ') : tree?.children?.map(text).join(' ') ?? '';
const serialized = tree => JSON.stringify(tree);
const props = (rows = []) => {
  const win = { start: 0, end: 120_000, step: 60_000 };
  const stats = data.analyze(rows, win);
  return { ...stats, groups: data.modelGroups(stats.models), total: stats.kpi.total, step: win.step, win, lookup: new Map() };
};
const call = (extra = {}) => ({ time: 1000, session: 's1', provider: 'test', model: 'model-a', ok: true,
  input: 80, cacheRead: 30, cacheWrite: 10, output: 20, total: 140, ttft: 100, duration: 1100, ...extra });
const components = ['TokenBars', 'ModelArea', 'Models', 'Throughput', 'Results', 'TokenDonut', 'Latency', 'Ribbons', 'Speed', 'Matrix'];

function charts(host) { return require('../src/usage-charts.cjs').createCharts(host.React); }

function finiteSvg(tree) {
  for (const node of nodes(tree, () => true)) {
    for (const [key, value] of Object.entries(node.props)) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `${node.type}.${key} is finite`);
      if (value !== undefined && ['d', 'points', 'viewBox', 'strokeDasharray', 'transform'].includes(key)) assert.doesNotMatch(String(value), /NaN|Infinity|undefined/);
      if (['width', 'height', 'r', 'rx'].includes(key) && typeof value === 'number') assert.ok(value >= 0, `${node.type}.${key} is nonnegative`);
    }
  }
}

test('chart factory exports every requested component', () => {
  const host = harness();
  assert.deepEqual(Object.keys(charts(host)).sort(), [...components].sort());
});

for (const [scenario, rows] of [['empty', []], ['single', [call()]], ['zero tokens', [call({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })]], ['sparse', [call(), call({ time: 119_999, model: 'model-b', ok: false })]]]) {
  test(`all chart cards render finite geometry with ${scenario} data`, () => {
    for (const name of components) {
      const host = harness();
      const tree = host.render(charts(host)[name], props(rows));
      assert.equal(tree.type, 'section', name);
      assert.match(tree.props.className, /auralis-usage-card/, name);
      assert.equal(nodes(tree, node => node.type === 'h2').length, 1, name);
      const notes = nodes(tree, node => node.props.className === 'auralis-usage-note');
      assert.equal(notes.length, ['Throughput', 'Latency', 'Speed'].includes(name) ? 1 : 0, `${name} only keeps necessary metric notes`);
      assert.equal(nodes(tree, node => node.type === 'details').length, 0, `${name} removes duplicate data disclosure`);
      assert.doesNotMatch(text(tree), /查看数据|悬停、聚焦|颜色按 Token|非完整桶按实际/);
      finiteSvg(tree);
      assert.doesNotMatch(serialized(tree), /https?:\/\//);
    }
  });
}

test('cartesian charts resize their coordinates to the viewport without stretching text', () => {
  const original = globalThis.ResizeObserver;
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected = true; }
  };
  try {
    for (const name of ['TokenBars', 'ModelArea', 'Throughput', 'Results', 'Latency']) {
      const host = harness();
      const effects = [];
      host.React.useEffect = effect => effects.push(effect);
      const view = charts(host);
      const values = props([call(), call({ time: 61_000, model: 'model-b' })]);
      let tree = host.render(view[name], values);
      let viewport = nodes(tree, node => node.props.className === 'auralis-usage-chart')[0];
      const frame = nodes(tree, node => node.props.className === 'auralis-usage-chart-frame')[0];
      assert.equal(frame?.type, 'div', 'measure an HTML viewport, not the SVG graphics bounding box');
      assert.equal(typeof frame.props.ref, 'function', name);
      frame.props.ref({ getBoundingClientRect: () => ({ width: 1200, height: 260 }) });
      tree = host.render(view[name], values);
      const cleanups = effects.splice(0).map(effect => effect());
      const observer = observers.at(-1);
      for (const width of [1200, 1600, 380, 320, 256]) {
        observer.callback([{ contentRect: { width, height: 260 } }]);
        tree = host.render(view[name], values);
        viewport = nodes(tree, node => node.props.className === 'auralis-usage-chart')[0];
        assert.equal(viewport.props.viewBox, `0 0 ${width} 260`, name);
        assert.notEqual(viewport.props.preserveAspectRatio, 'none', 'text and round marks must not distort');
        const grids = nodes(viewport, node => node.type === 'line' && node.props.x1 === 62 && node.props.x2 === width - 62);
        assert.ok(grids.length > 0, `${name} keeps fixed axis gutters across widths`);
        const tooltipTargets = nodes(viewport, node => node.props['data-bucket-index'] !== undefined);
        if (tooltipTargets.length) {
          const rects = tooltipTargets.map(target => nodes(target, node => node.type === 'rect')[0]);
          assert.equal(rects[0].props.x, 62);
          const last = rects.at(-1).props;
          assert.ok(Math.abs(last.x + last.width - (width - 62)) < 0.001);
          tooltipTargets.at(-1).props.onFocus();
          tree = host.render(view[name], values);
          const tip = nodes(tree, node => node.props.className === 'auralis-usage-chart-tooltip')[0];
          const box = nodes(tip, node => node.type === 'rect')[0].props;
          assert.ok(box.x >= 62 && box.x + box.width <= width - 62 + 0.001, 'tooltip follows the resized drawing area');
        }
        if (name === 'Latency') {
          for (const match of [node => node.props['data-latency-sample'] === 0, node => node.props['data-p95-axis'] === 'ttft']) {
            const target = nodes(tree, match)[0];
            target.props.onFocus();
            tree = host.render(view[name], values);
            const tip = nodes(tree, node => node.props.className === 'auralis-usage-chart-tooltip')[0];
            const box = nodes(tip, node => node.type === 'rect')[0].props;
            assert.ok(box.x >= 0 && box.x + box.width <= width, 'scatter tooltip stays inside a narrow card');
            target.props.onBlur();
            tree = host.render(view[name], values);
          }
        }
        finiteSvg(tree);
      }
      observer.callback([{ contentRect: { width: 0, height: 0 } }]);
      tree = host.render(view[name], values);
      assert.equal(nodes(tree, node => node.props.className === 'auralis-usage-chart')[0].props.viewBox, '0 0 256 260', 'hidden zero-size measurements do not collapse the drawing');
      cleanups.forEach(cleanup => cleanup?.());
      assert.equal(observer.disconnected, true, 'resize subscription is disposed');
      observer.callback([{ contentRect: { width: 900, height: 260 } }]);
      tree = host.render(view[name], values);
      assert.equal(nodes(tree, node => node.props.className === 'auralis-usage-chart')[0].props.viewBox, '0 0 256 260', 'late resize callbacks cannot update a disposed subscription');
    }
  } finally {
    if (original === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = original;
  }
});

test('gradient ids are unique between instances and all references resolve', () => {
  const host = harness();
  const view = charts(host);
  const trees = ['TokenBars', 'TokenBars', 'Throughput', 'Results', 'Results'].map(name => host.render(view[name], props([call()])));
  const ids = nodes(trees, node => node.type === 'linearGradient').map(node => node.props.id);
  assert.ok(ids.length >= 10);
  assert.equal(new Set(ids).size, ids.length);
  for (const node of nodes(trees, () => true)) {
    for (const value of Object.values(node.props)) {
      const match = typeof value === 'string' && value.match(/^url\(#(.+)\)$/);
      if (match) assert.ok(ids.includes(match[1]));
    }
  }
});

test('token chart keeps four disjoint stacks, calls and bucket mean references', () => {
  const host = harness();
  const tree = host.render(charts(host).TokenBars, props([call()]));
  const stacks = nodes(tree, node => node.props['data-token-part']);
  assert.equal(stacks.length, 4);
  assert.deepEqual(stacks.map(node => node.props['data-token-part']), data.TOKEN_PARTS.map(part => part.key));
  assert.ok(nodes(tree, node => node.props['data-series'] === 'calls').every(node => node.props.strokeDasharray));
  assert.ok(nodes(tree, node => node.props['data-reference'] === 'mean').length);
  assert.match(text(tree), /左轴|Tokens/);
  assert.match(text(tree), /右轴|请求/);
});

test('tiny token segments never grow across their disjoint stack boundaries', () => {
  const host = harness();
  const values = props([call({ input: 1, cacheRead: 1, cacheWrite: 1, output: 1e9, total: 1e9 + 3 })]);
  const tree = host.render(charts(host).TokenBars, values);
  const marks = nodes(tree, node => node.props['data-token-part']);
  for (let index = 0; index < marks.length - 1; index++) {
    assert.ok(marks[index + 1].props.y + marks[index + 1].props.height <= marks[index].props.y + 1e-9);
  }
  assert.ok(marks[0].props.y + marks[0].props.height <= 214 + 1e-9);
});

test('model legend toggles locally and keeps the input data unchanged', () => {
  const host = harness();
  const view = charts(host);
  const values = props([call(), call({ model: 'model-b', time: 61_000 })]);
  const before = serialized(values);
  let tree = host.render(view.ModelArea, values);
  const legend = nodes(tree, node => node.type === 'button' && node.props['data-model-key']);
  assert.equal(legend.length, 2);
  assert.match(text(legend[0]), /140 Tokens/);
  assert.match(text(legend[0]), /50\.0%/);
  legend[0].props.onClick();
  tree = host.render(view.ModelArea, values);
  const updated = nodes(tree, node => node.type === 'button' && node.props['data-model-key']);
  assert.equal(updated[0].props['aria-pressed'], false);
  assert.equal(updated[1].props['aria-pressed'], true);
  assert.equal(nodes(tree, node => node.props['data-area-key'] === legend[0].props['data-model-key']).length, 0);
  assert.equal(serialized(values), before);
  updated[1].props.onClick();
  tree = host.render(view.ModelArea, values);
  assert.match(text(tree), /已隐藏全部模型/);
});

test('model table and donut sectors share keyboard-accessible highlight state', () => {
  const host = harness();
  const view = charts(host);
  const values = props([call(), call({ model: 'model-b' })]);
  let tree = host.render(view.Models, values);
  const buttons = nodes(tree, node => node.type === 'button' && node.props['data-model-key']);
  assert.ok(buttons.length >= 2);
  buttons[0].props.onFocus();
  tree = host.render(view.Models, values);
  const active = nodes(tree, node => node.props['data-sector-key'] === buttons[0].props['data-model-key'] && node.props['data-active'])[0];
  assert.ok(active);
  const translation = active.props.transform.match(/translate\(([-\d.]+) ([-\d.]+)\)/).slice(1).map(Number);
  assert.ok(Math.abs(Math.hypot(...translation) - 8) < 0.02, 'active sector moves 8px away from the center');
  buttons[0].props.onClick();
  buttons[0].props.onBlur();
  tree = host.render(view.Models, values);
  assert.ok(nodes(tree, node => node.props['data-sector-key'] === buttons[0].props['data-model-key'] && node.props['data-active']).length);
});

test('model highlight ignores selections and hovered keys absent from the current range', () => {
  for (const interaction of ['onClick', 'onMouseEnter']) {
    const host = harness();
    const view = charts(host);
    const before = props([call()]);
    let tree = host.render(view.Models, before);
    const button = nodes(tree, node => node.type === 'button' && node.props['data-model-key'])[0];
    button.props[interaction]();
    tree = host.render(view.Models, props([call({ model: 'model-b' })]));
    const sectors = nodes(tree, node => node.props['data-sector-key']);
    assert.equal(sectors.length, 1);
    assert.equal(sectors[0].props.opacity, 1, `${interaction}: obsolete keys do not dim every visible model`);
    assert.equal(sectors[0].props['data-active'], false);
  }
});

test('throughput splits raw calls by time rather than treating a 1min tail as half the window', () => {
  const host = harness();
  const rows = Array.from({ length: 122 }, (_, index) => call({ time: index * 30_000 + 15_000, total: index < 120 ? 50 : 500 }));
  const win = { start: 0, end: 61 * 60_000, step: 60 * 60_000 };
  const stats = data.analyze(rows, win);
  const tree = host.render(charts(host).Throughput, { ...stats, rows, win, step: win.step });
  const summary = text(nodes(tree, node => node.props.className === 'auralis-usage-note')[0]);
  assert.match(summary, /前后半段.*\+29\.5%.*\+0%/);
  assert.doesNotMatch(summary, /900%/);
});

test('throughput fallback explicitly names bucket-half means and honors end-exclusive windows', () => {
  const host = harness();
  const view = charts(host);
  const base = props([call()]);
  let tree = host.render(view.Throughput, { series: base.series, step: base.step, kpi: base.kpi });
  assert.match(text(tree), /前后半组桶均值/);
  const rows = [call({ time: 25_000, total: 100 }), call({ time: 50_000, total: 100 }), call({ time: 100_000, total: 10000 })];
  const win = { start: 0, end: 100_000, step: 60_000, endExclusive: true };
  const stats = data.analyze(rows, win);
  tree = host.render(view.Throughput, { ...stats, rows, win, step: win.step });
  assert.match(text(nodes(tree, node => node.props.className === 'auralis-usage-note')[0]), /前后半段.*\+0%.*\+0%/);
});

test('throughput normalizes a partial bucket by its actual span', () => {
  const host = harness();
  const values = props([call()]);
  values.series = [{ ...values.series[0], span: 30_000 }];
  const tree = host.render(charts(host).Throughput, values);
  const hit = nodes(tree, node => node.props['data-bucket-index'] === 0)[0];
  assert.match(hit.props['aria-label'], /280/);
  assert.match(hit.props['aria-label'], /2\.00/);
});

test('throughput axes keep every positive low-rate tick distinguishable from zero', () => {
  for (const minutes of [60, 1e7]) {
    const host = harness();
    const values = props([call({ total: 12 })]);
    values.series = [{ ...values.series[0], total: 12, calls: 1, span: minutes * 60_000 }];
    values.kpi = { ...values.kpi, tpm: 12 / minutes, rpm: 1 / minutes };
    const tree = host.render(charts(host).Throughput, values);
    const axis = nodes(tree, node => node.props.className === 'auralis-usage-chart-axis')[0];
    for (const x of [53, 587]) {
      const ticks = nodes(axis, node => node.type === 'text' && node.props.x === x).map(node => Number(text(node)));
      assert.equal(ticks.length, 5);
      assert.equal(ticks[0], 0);
      assert.ok(ticks.slice(1).every(value => value > 0), `${minutes}min axis ${x} preserves positive values`);
      assert.equal(new Set(ticks).size, 5);
    }
    const label = nodes(tree, node => node.props['data-bucket-index'] === 0)[0].props['aria-label'];
    assert.doesNotMatch(label, /(?:Tokens|min) 0\.00(?:；|$)/);
  }
});

test('single-bucket time charts retain visible request and throughput marks', () => {
  for (const name of ['TokenBars', 'Throughput']) {
    const host = harness();
    const values = props([call()]);
    values.series = values.series.slice(0, 1);
    const tree = host.render(charts(host)[name], values);
    const marks = nodes(tree, node => node.type === 'circle' && node.props['data-series']);
    assert.ok(marks.some(node => node.props['data-series'] === 'calls'), name);
    if (name === 'Throughput') assert.ok(marks.some(node => node.props['data-series'] === 'tokens'));
    finiteSvg(tree);
  }
});

test('extreme stacked model values keep smooth non-crossing boundaries', () => {
  const host = harness();
  const values = props([call(), call({ model: 'model-b' })]);
  const [a, b] = values.groups;
  values.series = [
    { time: 0, models: { [a.key]: 10_000, [b.key]: 1 } },
    { time: 1000, models: { [a.key]: 1, [b.key]: 10_000 } },
    { time: 2000, models: { [a.key]: 20_000, [b.key]: 0 } },
  ];
  const tree = host.render(charts(host).ModelArea, values);
  const paths = nodes(tree, node => node.props['data-area-key']);
  assert.equal(paths.length, 2);
  for (const node of paths) {
    const split = node.props.d.split(' L');
    assert.equal(split.length, 2);
    const top = [...split[0].matchAll(/(?:M|C)([\d.]+) ([\d.]+)(?: ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+))?/g)];
    const bottom = [...(`M${split[1]}`).matchAll(/(?:M|C)([\d.]+) ([\d.]+)(?: ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+))?/g)];
    const topY = [Number(top[0][2]), ...top.slice(1).map(segment => Number(segment[6]))];
    const bottomY = [Number(bottom[0][2]), ...bottom.slice(1).map(segment => Number(segment[6]))].reverse();
    assert.ok(topY.every((y, index) => y <= bottomY[index]));
    for (const boundary of [top, bottom]) {
      boundary.slice(1).forEach((segment, index) => {
        assert.equal(Number(segment[2]), Number(index ? boundary[index][6] : boundary[0][2]), 'first control stays on previous endpoint');
        assert.equal(Number(segment[4]), Number(segment[6]), 'second control stays on next endpoint');
      });
    }
  }
});

test('results uses an orange failure-rate line and omits empty buckets', () => {
  const host = harness();
  const tree = host.render(charts(host).Results, props([call({ ok: false }), call(), call(), call()]));
  const points = nodes(tree, node => node.props['data-failure-rate'] !== undefined);
  assert.equal(points.length, 1);
  assert.equal(points[0].props['data-failure-rate'], 0.25);
  assert.match(points[0].props.fill, /--auralis-usage-chart-orange/);
  const line = nodes(tree, node => node.props['data-series'] === 'failure-rate')[0];
  assert.match(line.props.stroke, /--auralis-usage-chart-orange/);
  assert.ok(line.props.strokeDasharray);
  assert.match(text(tree), /失败率/);
  assert.match(text(tree), /100%/);
  assert.equal(nodes(tree, node => node.props.className === 'auralis-usage-note').length, 0, 'success summary is not duplicated below the result chart');
});

test('token donut has unique vertical gradients and four 4px progress bars', () => {
  const host = harness();
  const view = charts(host);
  const values = props([call()]);
  const trees = [host.render(view.TokenDonut, values), host.render(view.TokenDonut, values)];
  const gradients = nodes(trees, node => node.type === 'linearGradient');
  assert.equal(gradients.length, 8);
  assert.equal(new Set(gradients.map(node => node.props.id)).size, 8);
  assert.ok(gradients.every(node => node.props.x1 === '0' && node.props.x2 === '0' && node.props.y2 === '1'));
  const sectors = nodes(trees[0], node => node.props['data-sector-key']);
  assert.ok(sectors.every(node => /^url\(#/.test(node.props.fill)));
  const bars = nodes(trees[0], node => node.props['data-token-progress']);
  assert.equal(bars.length, 4);
  assert.ok(bars.every(node => node.props.style.height === 4));
  assert.equal(bars.reduce((total, node) => total + Number.parseFloat(node.children[0].props.style.width), 0), 100);
});

test('latency keeps one concise paired P95 note without full statistics prose', () => {
  const host = harness();
  const values = props([call()]);
  values.ttft = { count: 30, p50: 500, p95: 3000 };
  values.duration = { count: 40, p50: 2000, p95: 120_000 };
  const tree = host.render(charts(host).Latency, values);
  const summary = text(nodes(tree, node => node.props.className === 'auralis-usage-note')[0]);
  assert.match(summary, /1 个样本.*配对全集 P95：首字 100 ms \/ 耗时 1\.10 s/);
  assert.doesNotMatch(summary, /全部成功样本|P50|查看数据/);
  assert.ok(summary.length < 100);
  const p95 = nodes(tree, node => node.props['data-p95-axis']);
  assert.deepEqual(p95.map(node => node.props['data-p95-value']), [100, 1100]);
});

test('latency uses positive paired P95 and deterministically caps displayed samples', () => {
  const host = harness();
  const values = props();
  values.points = Array.from({ length: 1001 }, (_, index) => ({ ttft: index + 1, duration: (index + 1) * 2, key: 'test/a' }));
  values.points.push({ ttft: 0, duration: 1 }, { ttft: 1, duration: Infinity }, { ttft: 1, duration: 1, ok: false });
  values.ttft = { p95: 9e9, count: 20 };
  values.duration = { p95: 9e9, count: 20 };
  const tree = host.render(charts(host).Latency, values);
  const samples = nodes(tree, node => node.props['data-latency-sample'] !== undefined);
  assert.equal(samples.length, 800);
  const p95 = nodes(tree, node => node.props['data-p95-axis']);
  assert.equal(p95.length, 2);
  assert.deepEqual(p95.map(node => node.props['data-p95-value']), [951, 1902]);
  assert.match(text(tree), /800.*1,001/);
  assert.ok(p95.every(node => node.props.tabIndex === 0 && typeof node.props.onFocus === 'function'));
  finiteSvg(tree);
  p95[0].props.onFocus();
  const focused = host.render(charts(host).Latency, values);
  const line = nodes(focused, node => node.props['data-p95-axis'] === 'ttft')[0];
  assert.ok(nodes(line, node => node.type === 'line' && node.props.strokeWidth === 3).length);
  assert.match(text(line), /首字 P95 951 ms/);
  assert.deepEqual(nodes(focused, node => node.props['data-latency-sample'] !== undefined).map(node => node.props['aria-label']), samples.map(node => node.props['aria-label']));
});

test('ribbon SVG geometry and list share fixed 72px rows', () => {
  const host = harness();
  const tree = host.render(charts(host).Ribbons, props([call(), call({ model: 'b' })]));
  const svg = nodes(tree, node => node.type === 'svg')[0];
  assert.equal(svg.props.height, 144);
  assert.equal(svg.props.viewBox, '0 0 240 144');
  const rows = nodes(tree, node => node.props.className === 'auralis-usage-ribbon-row');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(node => node.props.style.height === 72));
  for (const path of nodes(tree, node => node.type === 'path')) assert.equal((path.props.d.match(/C/g) ?? []).length, 2);
});

test('speed preserves missing halves and matrix retains every session', () => {
  const host = harness();
  const values = props(Array.from({ length: 15 }, (_, index) => call({ session: `s${index}`, model: `m${index}` })));
  const speed = host.render(charts(host).Speed, values);
  assert.equal(nodes(speed, node => node.props['data-speed-key']).length, 15);
  assert.match(text(speed), /估算/);
  assert.match(text(speed), /无样本/);
  const matrixHost = harness();
  const matrix = matrixHost.render(charts(matrixHost).Matrix, values);
  assert.equal(nodes(matrix, node => node.props['data-session-id']).length, 15);
  assert.equal(nodes(matrix, node => node.props['data-heat-value'] !== undefined).length, 15 * values.groups.length);
});

test('heatmap text preserves readable contrast across its sequential ramp', () => {
  const host = harness();
  const values = props(Array.from({ length: 101 }, (_, index) => call({ session: `s${index}`, total: index + 1 })));
  const tree = host.render(charts(host).Matrix, values);
  const luminance = rgb => rgb.map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((result, channel, index) => result + channel * [0.2126, 0.7152, 0.0722][index], 0);
  for (const cell of nodes(tree, node => node.props['data-heat-value'] > 0)) {
    const background = luminance(cell.props.style.background.match(/\d+/g).map(Number));
    const raw = cell.props.style.color.slice(1);
    const hex = raw.length === 3 ? raw.split('').map(char => char + char).join('') : raw;
    const foreground = luminance([0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16)));
    assert.ok((Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) >= 4.5,
      `${cell.props.style.color} on ${cell.props.style.background} retains 4.5:1 text contrast`);
  }
});
