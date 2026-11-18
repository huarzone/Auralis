import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { apply, inject, themeTokens, createComponents, surfaceStyles, wallpaper, PLUGINS_PANEL, USAGE_PANEL } = require('../src/client.cjs');

function fixture() {
  const effects = [];
  const slots = [];
  const pages = [];
  let removedTokens = 0;
  let removedSlots = 0;
  const ctx = {
    theme: { overrideTokens(source, tokens) {
      assert.equal(source, 'auralis');
      assert.equal(tokens, themeTokens);
      return () => removedTokens++;
    } },
    slots: {
      inject(name, callback) { slots.push({ name, callback }); return () => removedSlots++; },
      register(options, component) { return { options, component }; },
    },
    effect(callback) { effects.push(callback()); },
    // 账号依赖在测试里不提供，只登记 layout。
    inject(deps, callback) { pages.push({ deps, dispose: deps[0] === 'layout' ? callback(pageCtx) : () => {} }); },
  };
  const pageCtx = { slots: ctx.slots };
  return { ctx, effects, slots, pages, removed: () => ({ tokens: removedTokens, slots: removedSlots }) };
}

test('plugin uses public theme and settings-launcher services with disposable resources', () => {
  const { ctx, effects, slots, pages, removed } = fixture();
  assert.deepEqual(inject, ['theme', 'slots']);
  apply(ctx);
  assert.deepEqual(slots.map(slot => slot.name), [
    'settings.launcher', 'shell.overlay', 'sidebar.panellist', 'settings.section',
    'main', 'sidebar.panellist',
  ]);
  const surface = slots[1].callback();
  assert.equal(surface.options.id, 'auralis.theme');
  assert.equal(typeof surface.component, 'function');
  const registration = slots[0].callback();
  assert.equal(registration.options.name, 'settings.launcher');
  assert.equal(registration.options.priority, -1, 'must outrank the official account launcher instead of colliding');
  assert.equal(typeof registration.component, 'function');
  assert.deepEqual(pages.map(page => page.deps), [['layout'], ['remote', 'remote.account', 'locale']]);
  pages[0].dispose();
  effects.reverse().forEach(dispose => dispose());
  assert.deepEqual(removed(), { tokens: 1, slots: 6 });
});

test('sidebar renames Plugins to 插件中心 by shadowing the official entry, and adds 使用分析 right below it', () => {
  const { ctx, slots } = fixture();
  apply(ctx);
  const [center, , page, entry] = slots.slice(2).map(slot => slot.callback().options);
  assert.deepEqual(center, { name: 'sidebar.panellist', id: PLUGINS_PANEL, order: 0, priority: -1, label: '插件中心' });
  assert.deepEqual(page, { name: 'main', key: USAGE_PANEL });
  assert.equal(entry.id, USAGE_PANEL);
  assert.equal(entry.label, '使用分析');
  assert.ok(entry.order > 0 && entry.order < 10, 'usage sits between 插件中心 (0) and other plugins (10)');
  assert.equal(entry.priority, undefined);
});

test('layout registers only 使用分析 without asset, creative or execution workspaces', () => {
  const { ctx, slots, pages, removed } = fixture();
  apply(ctx);
  assert.equal(USAGE_PANEL, 'auralis.usage');
  const registrations = slots.map(slot => slot.callback());
  const entries = registrations.filter(item => item.options.name === 'sidebar.panellist' && item.options.id !== PLUGINS_PANEL);
  const panels = registrations.filter(item => item.options.name === 'main');
  assert.equal(entries.length, 1);
  assert.equal(panels.length, 1);
  assert.deepEqual(entries[0].options, { name: 'sidebar.panellist', id: USAGE_PANEL, order: 1, label: '使用分析' });
  assert.deepEqual(panels[0].options, { name: 'main', key: USAGE_PANEL });
  assert.equal(typeof entries[0].component, 'function');
  assert.equal(typeof panels[0].component, 'function');
  assert.doesNotMatch(JSON.stringify(registrations.map(item => item.options)), /assets|creative|studio|execution|素材库|创作工作台|执行台/);
  assert.ok(pages.every(page => !page.deps.includes('sidebarRight') && !page.deps.includes('sidebarRightTabs')));
  pages[0].dispose();
  assert.equal(removed().slots, 2, 'layout releases only the usage panel and entry');
});

test('theme and usage switches reconcile without duplicate slots while settings remain mounted', async () => {
  const clientRequire = createRequire(new URL('../src/client.cjs', import.meta.url));
  const { DEFAULTS, normalize } = clientRequire('./settings-model.cjs');
  let settings = normalize(DEFAULTS);
  const listeners = new Set();
  const store = {
    getSnapshot: () => ({ settings }), subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    load() {}, flush() {},
  };
  const module = { exports: {} };
  runInNewContext(await readFile(new URL('../src/client.cjs', import.meta.url), 'utf8'), {
    module, __dirname: resolve(import.meta.dirname, '../src'),
    require: name => name === './settings-client.cjs'
      ? { ...clientRequire(name), createSettingsClient: () => store } : clientRequire(name),
  });
  const active = new Set();
  const releases = [];
  let activeTokens = 0;
  const ctx = {
    theme: { overrideTokens() { activeTokens++; return () => activeTokens--; } },
    slots: {
      register: (options, component) => ({ options, component }),
      inject(name, callback) {
        const registration = callback();
        active.add(registration);
        return () => active.delete(registration);
      },
    },
    effect: callback => releases.push(callback()),
    inject: (deps, callback) => { if (deps[0] === 'layout') releases.push(callback(ctx)); },
  };
  module.exports.apply(ctx);
  const settingsSlots = () => [...active].filter(({ options }) => options.name === 'settings.section');
  const usageSlots = () => [...active].filter(({ options }) => options.id === USAGE_PANEL || options.key === USAGE_PANEL);
  const surfaceSlots = () => [...active].filter(({ options }) => options.id === 'auralis.theme');
  const originalSettings = settingsSlots();
  assert.equal(originalSettings.length, 1);
  assert.equal(originalSettings[0].options.id, 'auralis');
  assert.equal(originalSettings[0].options.label, 'Auralis');
  assert.equal(active.size, 6);
  assert.equal(activeTokens, 1);
  assert.equal(usageSlots().length, 2);
  assert.equal(surfaceSlots().length, 1);
  const update = value => {
    settings = normalize(value);
    listeners.forEach(notify => notify());
    assert.deepEqual(settingsSlots(), originalSettings, 'settings stay available while features are disabled');
    const identities = [...active].map(({ options }) => `${options.name}:${options.id ?? options.key ?? ''}`);
    assert.equal(new Set(identities).size, identities.length, 'preference changes must not duplicate slots');
  };
  update({ appearance: { enabled: false }, usage: { enabled: true } });
  assert.equal(activeTokens, 0);
  assert.equal(surfaceSlots().length, 0);
  assert.equal(usageSlots().length, 2);
  update({ appearance: { enabled: true }, usage: { enabled: false } });
  assert.equal(activeTokens, 1);
  assert.equal(surfaceSlots().length, 1);
  assert.equal(usageSlots().length, 0);
  update({ appearance: { enabled: false }, usage: { enabled: false } });
  assert.equal(activeTokens, 0);
  assert.equal(surfaceSlots().length, 0);
  assert.equal(usageSlots().length, 0);
  assert.equal(active.size, 3, 'only launcher, plugin center and settings remain');
  update(DEFAULTS);
  assert.equal(activeTokens, 1);
  assert.equal(surfaceSlots().length, 1);
  assert.equal(usageSlots().length, 2);
  assert.equal(active.size, 6);
  const restored = [...active];
  update(DEFAULTS);
  assert.deepEqual([...active], restored, 'unchanged preferences do not remount active slots');
  releases.reverse().forEach(dispose => dispose());
  assert.equal(active.size, 0);
  assert.equal(activeTokens, 0);
  assert.equal(listeners.size, 0);
});

test('sidebar More menu is left to the official entry-customization plugin', () => {
  const { ctx, slots } = fixture();
  apply(ctx);
  assert.ok(slots.every(slot => slot.name !== 'sidebar.panellist.actions'));
});

test('theme overrides specify readable light and dark palettes without remote assets', () => {
  assert.ok(Object.keys(themeTokens).length >= 8);
  for (const [name, colors] of Object.entries(themeTokens)) {
    assert.match(name, /^--dsw-(?:alias|specific)-/);
    assert.match(colors.light, /^#[\da-f]{6}(?:[\da-f]{2})?$/i);
    assert.match(colors.dark, /^#[\da-f]{6}(?:[\da-f]{2})?$/i);
  }
  assert.equal(themeTokens['--dsw-alias-bg-base'].light, '#f2f8fd');
  assert.equal(themeTokens['--dsw-alias-bg-base'].dark, '#0f1a26');
  assert.equal(themeTokens['--dsw-alias-brand-primary'].light, '#2f8fd8');
});

test('native control, menu and selection surfaces are translucent in both schemes', () => {
  const surfaces = [
    '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-overlay',
    '--dsw-specific-input-major', '--dsw-specific-menu', '--dsw-specific-selector',
    '--dsw-alias-button-floating-fill', '--dsw-alias-button-elevated-fill', '--dsw-alias-button-ghost-active-fill',
    '--dsw-alias-interactive-bg-hover-solid', '--dsw-specific-sidebar-nav-item-active', '--dsw-alias-bg-module-platform',
    '--dsw-specific-sidebar-nav-item-hover', '--dsw-specific-sidebar-nav-item-active-accent', '--dsw-alias-button-floating-hover',
    '--dsw-alias-button-ghost-active-hover', '--dsw-alias-button-primary-hover', '--dsw-alias-bg-multi-select',
  ];
  for (const name of surfaces) {
    for (const scheme of ['light', 'dark']) {
      const value = themeTokens[name]?.[scheme];
      assert.match(value ?? '', /^#[\da-f]{8}$/i, `${name} ${scheme}`);
      assert.ok(parseInt(value.slice(7), 16) < 0xf0, `${name} ${scheme} must be translucent`);
    }
  }
  assert.equal(themeTokens['--dsw-specific-sidebar-fill'].light, '#00000000');
  assert.equal(themeTokens['--dsw-specific-sidebar-fill'].dark, '#00000000');
});

test('left sidebar stays see-through with a frosted backdrop', () => {
  const rule = surfaceStyles.match(/> div:has\(> \[data-slot="sidebar"\]\)\{[^}]*\}/)[0];
  const alpha = Number(rule.match(/bg-layer-1\) (\d+)%/)[1]);
  assert.ok(alpha <= 50, `sidebar mix ${alpha}% is too opaque`);
  assert.match(rule, /backdrop-filter:blur\(/);
  assert.match(surfaceStyles, /\[data-ds-dark-theme\] [^{]+\{--auralis-veil:(\d+)%/);
  assert.ok(Number(surfaceStyles.match(/\[data-ds-dark-theme\] [^{]+\{--auralis-veil:(\d+)%/)[1]) <= 65);
});

test('hover and selection states are tinted highlights, not opaque fills', () => {
  for (const name of ['--dsw-specific-sidebar-nav-item-hover', '--dsw-specific-sidebar-nav-item-active', '--dsw-alias-interactive-bg-hover-solid']) {
    for (const scheme of ['light', 'dark']) assert.ok(parseInt(themeTokens[name][scheme].slice(7), 16) <= 0x40, `${name} ${scheme}`);
  }
});

test('settings glass stays behind content without changing fixed drag-overlay coordinates', () => {
  const selector = '[role="dialog"][data-shortcut-modal="settings"]';
  const rule = target => surfaceStyles.split('\n').find(line => line.startsWith(`${target}{`)) ?? '';
  const panel = rule(selector);
  assert.match(panel, /background:transparent/);
  assert.match(panel, /backdrop-filter:none/);
  assert.match(panel, /isolation:isolate/);
  assert.match(panel, /border:1px solid/);
  assert.doesNotMatch(panel, /(?:^|[;{])(?:transform|filter|perspective|contain|will-change):/);
  const glass = rule(`${selector}::before`);
  assert.match(glass, /content:""/);
  assert.match(glass, /position:absolute;inset:0/);
  assert.match(glass, /z-index:-1;pointer-events:none/);
  assert.match(glass, /border-radius:inherit/);
  assert.match(glass, /backdrop-filter:blur\((?:2[4-9]|[3-9]\d)px\)/);
  assert.ok(Number(glass.match(/bg-base\) (\d+)%/)[1]) <= 30, 'settings glass is too opaque');
  const dark = rule(`[data-ds-dark-theme] ${selector}::before`);
  assert.ok(Number(dark.match(/bg-base\) (\d+)%/)[1]) <= 40, 'dark settings glass is too opaque');
  assert.match(surfaceStyles, /:has\(> \[data-shortcut-modal="settings"\]\)\{--dsw-mask-blur:blur\(/);
  const reduced = surfaceStyles.slice(surfaceStyles.indexOf('@media(prefers-reduced-transparency:reduce)'));
  assert.ok(reduced.includes(`${selector}::before,[data-ds-dark-theme] ${selector}::before{background:var(--dsw-alias-bg-base);backdrop-filter:none}`));
});

test('automation page drops its opaque base fill so the partition glass shows through', () => {
  const page = 'section[data-testid="task-manager-page"]';
  assert.ok(surfaceStyles.includes(`${page}{background:transparent}`));
  // 详情栏既出现在任务页内，也作为右栏标签页出现（不在 section 下），以其独有的详情页签定位。
  const detail = surfaceStyles.match(/aside:has\(\[data-detail-tab\]\)\{[^}]*\}/)?.[0] ?? '';
  assert.match(detail, /color-mix\(in srgb,var\(--dsw-alias-bg-base\) \d+%,transparent\)/);
  assert.match(detail, /backdrop-filter:blur\(/);
  assert.ok(surfaceStyles.includes('aside:has([data-detail-tab]) :is(footer,p[role]){background:transparent}'));
  assert.ok(surfaceStyles.includes('[data-dockkit-content]:has(aside:has([data-detail-tab])){background:transparent}'));
});

test('every automation field is frosted glass, including portalled and right-panel ones', () => {
  const glass = /background:color-mix\(in srgb,var\(--dsw-alias-bg-base\) (\d+)%,transparent\)/;
  const rule = selector => surfaceStyles.split('\n').find(line => line.startsWith(`${selector}{`)) ?? '';
  const fields = [
    'section[data-testid="task-manager-page"] div:has(> span > input[type=search])',
    ':is(section[data-testid="task-manager-page"],aside:has([data-detail-tab])) textarea',
    'input[data-menu-field]',
  ];
  for (const selector of fields) {
    const css = rule(selector);
    assert.match(css, glass, selector);
    assert.ok(Number(css.match(glass)[1]) <= 40, `${selector} is too opaque`);
  }
  // 搜索框只给外框上色：内层 Input 外壳与 input 本身必须透明，否则圆角框里会出现一块直角色块。
  assert.ok(surfaceStyles.includes(
    'section[data-testid="task-manager-page"] :is(span:has(> input[type=search]),input[type=search]){background:transparent}'));
  assert.doesNotMatch(surfaceStyles, /input-major\)/, 'the 65% input-major fill reads as a solid block');
  // 会话里的「已创建定时任务」卡片写死 static-neutral 实色，明暗两套都改为半透明。
  assert.match(rule('div[data-tool="schedule_create"]'), /--card-fill:color-mix\(.*--card-hover:color-mix\(/);
  assert.match(rule('body[data-ds-dark-theme] div[data-tool="schedule_create"]'), /--card-fill:color-mix\(/);
  const reduced = surfaceStyles.slice(surfaceStyles.indexOf('@media(prefers-reduced-transparency:reduce)'));
  assert.match(reduced, /input\[data-menu-field\][^{]*\{background:var\(--dsw-alias-bg-base\);backdrop-filter:none\}/);
});

test('sky theme keeps narrow partition seams and a round avatar', () => {
  assert.match(surfaceStyles, /--auralis-gap:2px/);
  assert.match(surfaceStyles, /--auralis-edge:4px/);
  assert.doesNotMatch(surfaceStyles, /margin:8px/);
  const { ProfileLauncher } = createComponents(fakeReact());
  const css = find(ProfileLauncher({ wide: true, settingsOpen: false, openSettings() {} }), node => node.type === 'style')[0].children[0];
  assert.match(css, /\.auralis-profile-avatar\{[^}]*border-radius:50%/);
  assert.match(css, /\[data-rail=true\] \.auralis-profile-avatar\{[^}]*border-radius:50%/);
});

function fakeReact() {
  return {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat() }; },
  };
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => find(child, predicate))];
}

test('profile launcher opens Settings directly from the avatar and nickname button', () => {
  const { ProfileLauncher, PixelAvatar } = createComponents(fakeReact());
  let settingsOpened = 0;
  const tree = ProfileLauncher({ wide: true, settingsOpen: false, openSettings() { settingsOpened++; } });
  const text = JSON.stringify(tree);
  assert.match(text, /Kared/);
  assert.doesNotMatch(text, /Sign in|Sign out|DeepSeek|反馈|登录/);
  const button = find(tree, node => node.type === 'button')[0];
  assert.equal(button.props['aria-haspopup'], 'dialog');
  assert.match(button.props['aria-label'], /Kared.*设置/);
  button.props.onClick();
  assert.equal(settingsOpened, 1);
  assert.equal(find(tree, node => ['menu', 'menuitem'].includes(node.props.role)).length, 0);
  assert.equal(find(tree, node => node.props.className === 'auralis-profile-settings').length, 1);
  assert.doesNotMatch(text, /auralis-profile-chevron/);
  const avatar = PixelAvatar();
  assert.equal(avatar.type, 'svg');
  assert.equal(avatar.props.shapeRendering, 'crispEdges');
  assert.ok(find(avatar, node => node.type === 'rect').length > 8);
  assert.equal(find(avatar, node => node.type === 'text').length, 0);
});

test('collapsed launcher preserves an accessible profile control without nickname text', () => {
  const { ProfileLauncher } = createComponents(fakeReact());
  let settingsOpened = 0;
  const tree = ProfileLauncher({ wide: false, settingsOpen: true, openSettings() { settingsOpened++; } });
  const button = find(tree, node => node.type === 'button' && node.props['aria-haspopup'] === 'dialog')[0];
  assert.ok(button);
  assert.match(button.props['aria-label'], /Kared.*设置/);
  assert.equal(button.props['aria-expanded'], true);
  button.props.onClick();
  assert.equal(settingsOpened, 1);
  assert.equal(find(tree, node => node.props['data-auralis-nickname']).length, 0);
});

test('theme surface inlines the bundled WebP wallpaper and small-radius native partitions', async () => {
  const { ThemeSurface } = createComponents(fakeReact());
  assert.equal(typeof ThemeSurface, 'function');
  const tree = ThemeSurface();
  assert.equal(tree.type, 'style');
  assert.equal(tree.props['data-auralis-theme'], true);
  assert.equal(tree.children[0], surfaceStyles);
  const asset = await readFile(resolve(import.meta.dirname, '../assets/wallpaper.webp'));
  assert.equal(asset.subarray(8, 12).toString('latin1'), 'WEBP');
  assert.equal(wallpaper, `data:image/webp;base64,${asset.toString('base64')}`);
  assert.ok(surfaceStyles.includes(`url("${wallpaper}")`));
  assert.match(surfaceStyles, /--auralis-radius:8px/);
  for (const slot of ['sidebar', 'main.conversation']) assert.ok(surfaceStyles.includes(`[data-slot="${slot}"]`));
  assert.match(surfaceStyles, /\[data-sidebar-right-panel="push"\]\[data-sidebar-right-open\]/);
  assert.match(surfaceStyles, /data-ds-dark-theme/);
  assert.match(surfaceStyles, /@media\s*\(max-width:767px\)/);
  assert.doesNotMatch(surfaceStyles, /https?:\/\/|grid-template-columns|!important/);
});

test('build inlines the wallpaper so the browser bundle never touches the filesystem', async () => {
  const bundle = await readFile(resolve(import.meta.dirname, '../dist/client.js'), 'utf8');
  assert.ok(bundle.includes(JSON.stringify(wallpaper)));
  assert.doesNotMatch(bundle, /readFileSync|node:fs|@auralis-wallpaper|require\('\.\/|createRequire/);
  assert.match(bundle, /auralis-usage-page/);
  assert.equal((bundle.match(/function analyze\(/g) ?? []).length, 1, 'shared local modules are bundled only once');
  let registration;
  runInNewContext(bundle, { window: { __ModuleLoader__: { load: value => { registration = value; } } } });
  const built = registration.factory(name => { throw new Error(`Unexpected eager host import: ${name}`); });
  assert.equal(registration.id, 'auralis');
  assert.equal(typeof built.apply, 'function');
  const { ctx, slots } = fixture();
  ctx.theme.overrideTokens = (source, tokens) => {
    assert.equal(source, 'auralis');
    assert.equal(JSON.stringify(tokens), JSON.stringify(themeTokens));
    return () => {};
  };
  built.apply(ctx);
  assert.equal(slots.length, 6);
});

test('theme bundle disables only UI entry points and never credential or approval services', async () => {
  const patch = await readFile(resolve(import.meta.dirname, '../cordis.patch.yml'), 'utf8');
  for (const id of ['ui-settings-account', 'ui-message-feedback']) assert.match(patch, new RegExp(`id: ${id}\\s+disabled: true`));
  assert.doesNotMatch(patch, /id: (?:credentials|connection|account-controller|message-feedback|user-approval)\s/);
  assert.match(patch, /name: auralis/);
  assert.match(patch, /id: ui-settings-models\s+config:\s+credentialOnboarding: false/);
});
