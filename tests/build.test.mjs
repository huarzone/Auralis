import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercises the distributed bundle rather than importing the unbundled view.
test('distributed bundle mounts the usage entry through host shared React only', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../dist/client.js'), 'utf8');
  let loaded;
  let serial = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useMemo: fn => fn(), useCallback: fn => fn, useEffect() {},
    useId: () => `bundle-${++serial}`, useRef: value => ({ current: value }),
  };
  const requested = [];
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { loaded = value; } } } });
  const plugin = loaded.factory(name => {
    requested.push(name);
    assert.equal(name, 'react');
    return React;
  });
  const slots = [];
  const slotsService = {
    inject(_, fn) { slots.push(fn()); return () => {}; },
    register(options, component) { return { options, component }; },
  };
  plugin.apply({
    theme: { overrideTokens: () => () => {} }, slots: slotsService,
    effect: fn => fn(), inject: (deps, fn) => deps[0] === 'layout' && fn({ slots: slotsService }),
  });
  const main = slots.find(slot => slot.options.name === 'main');
  assert.equal(main.options.key, 'auralis.usage');
  function render(node) {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }));
    return { ...node, children: node.children.map(render) };
  }
  const output = JSON.stringify(render(main.component()));
  assert.match(output, /使用分析/);
  assert.match(output, /30 分钟/);
  assert.match(output, /60 分钟/);
  assert.doesNotMatch(output, /https?:\/\//);
  assert.ok(requested.length > 0);
  assert.deepEqual([...new Set(requested)], ['react']);
});
