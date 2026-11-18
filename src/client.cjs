/**
 * Auralis 浏览器端：主题令牌与分区样式、头像入口（登录显示账号 / 未登录显示本地资料）、
 * 侧栏「插件中心」改名与「使用分析」面板，以及原生设置里的「Auralis」页签。
 * 偏好来自服务端共享存储（settings-client.cjs），可选功能按偏好热启停。仅使用 DSH 公开席位。
 */
'use strict';

const { createUsageView } = require('./usage-view.cjs');
const { createSettingsClient, watchAccount, resolveIdentity } = require('./settings-client.cjs');
const { DEFAULTS, normalize } = require('./settings-model.cjs');
const { createSettingsPage } = require('./settings-page.cjs');

// Native surfaces carry alpha so the wallpaper shows through inputs, buttons, selections and menus.
const themeTokens = {
  '--dsw-alias-bg-base': { light: '#f2f8fd', dark: '#0f1a26' },
  '--dsw-alias-bg-layer-1': { light: '#ffffffb8', dark: '#162433b8' },
  '--dsw-alias-bg-layer-2': { light: '#eaf4fcb3', dark: '#1e3144b3' },
  '--dsw-alias-bg-layer-3': { light: '#dcecf9b3', dark: '#263b52b3' },
  '--dsw-alias-bg-overlay': { light: '#f6fbffd9', dark: '#1a2b3cd9' },
  '--dsw-alias-bg-module-platform': { light: '#eef6fdb3', dark: '#1a2b3cb3' },
  '--dsw-alias-border-l1': { light: '#d6e6f3', dark: '#29405a' },
  '--dsw-alias-border-l2': { light: '#c2d9ec', dark: '#36506d' },
  '--dsw-alias-brand-primary': { light: '#2f8fd8', dark: '#7cc4f5' },
  '--dsw-alias-label-primary': { light: '#1d3448', dark: '#e8f2fb' },
  '--dsw-alias-label-secondary': { light: '#5d7890', dark: '#9fb8cf' },
  '--dsw-alias-button-floating-fill': { light: '#ffffffa6', dark: '#162433b3' },
  '--dsw-alias-button-elevated-fill': { light: '#ffffffb3', dark: '#20344ab3' },
  '--dsw-alias-button-floating-hover': { light: '#dcecf9c7', dark: '#2b4560c7' },
  '--dsw-alias-button-primary-hover': { light: '#2f8fd8cc', dark: '#7cc4f5cc' },
  '--dsw-alias-button-ghost-active-fill': { light: '#2f8fd829', dark: '#7cc4f529' },
  '--dsw-alias-button-ghost-active-hover': { light: '#2f8fd83d', dark: '#7cc4f53d' },
  '--dsw-alias-bg-multi-select': { light: '#2f8fd829', dark: '#7cc4f529' },
  '--dsw-specific-input-major': { light: '#ffffffa6', dark: '#14222fb3' },
  '--dsw-specific-menu': { light: '#f4f9fec7', dark: '#1a2b3cc7' },
  '--dsw-specific-sidebar-fill': { light: '#00000000', dark: '#00000000' },
  // Hover / selection are brand-tinted glass highlights instead of solid grey or white blocks.
  '--dsw-alias-interactive-bg-hover-solid': { light: '#2f8fd81f', dark: '#7cc4f51f' },
  '--dsw-specific-selector': { light: '#2f8fd824', dark: '#7cc4f524' },
  '--dsw-specific-sidebar-nav-item-hover': { light: '#2f8fd81f', dark: '#7cc4f51f' },
  '--dsw-specific-sidebar-nav-item-active': { light: '#2f8fd833', dark: '#7cc4f52e' },
  '--dsw-specific-sidebar-nav-item-active-accent': { light: '#2f8fd83d', dark: '#7cc4f538' },
};

// @auralis-wallpaper:start — build.mjs swaps this Node-only read for an inline data URI.
const wallpaper = `data:image/webp;base64,${require('node:fs').readFileSync(require('node:path').join(__dirname, '../assets/wallpaper.webp')).toString('base64')}`;
// @auralis-wallpaper:end

// Slot attributes and shell regions are checked against the pinned DSH version.
const frame = '[data-slot="root"] > div:has(> [data-shell-bottom]):has([data-auralis-theme])';
// The settings dialog is portalled to <body>, outside the frame, so it is targeted by its own attributes.
const settingsDialog = '[role="dialog"][data-shortcut-modal="settings"]';
// 官方「自动化任务」（dsh-client-ui-schedule）的实色面：页根、详情栏及其底栏 / 提示、指令输入框、搜索框、
// 时区搜索、会话里的「已创建定时任务」卡片。详情栏也会作为右栏标签页单独出现、时区菜单 portal 到 body，
// 二者都不在任务页 section 内，因此用组件自有属性定位：详情页签 data-detail-tab、菜单输入 data-menu-field。
const automation = 'section[data-testid="task-manager-page"]';
const taskDetail = 'aside:has([data-detail-tab])';
const taskSearch = `${automation} div:has(> span > input[type=search])`;
const taskInstruction = `:is(${automation},${taskDetail}) textarea`;
const taskMenuField = 'input[data-menu-field]';
const taskCard = 'div[data-tool="schedule_create"]';

/** 按偏好生成分区样式；默认偏好下与此前版本一致。`image` 为自定义背景的 blob 地址，缺省用内置壁纸。 */
function buildSurfaceStyles(settings = DEFAULTS, image = wallpaper) {
  const { appearance: a, pages } = normalize(settings);
  const blur = a.glass ? ';backdrop-filter:blur(18px) saturate(140%)' : '';
  const veil = 'color-mix(in srgb,var(--dsw-alias-bg-base) var(--auralis-veil),transparent)';
  const field = `background:color-mix(in srgb,var(--dsw-alias-bg-base) 32%,transparent)${blur}`;
  const card = percent => `color-mix(in srgb,var(--dsw-alias-bg-layer-1) ${percent}%,transparent)`;
  const cardFill = `--card-fill:${card(45)};--card-hover:${card(70)}`;
  return [
    `${frame}{--auralis-radius:8px;--auralis-gap:${a.gap}px;--auralis-edge:${a.edge}px;--auralis-veil:${a.veil}%;background-image:linear-gradient(${veil},${veil}),url("${image}");background-size:cover;background-position:center}`,
    `[data-ds-dark-theme] ${frame}{--auralis-veil:${a.veilDark}%}`,
    `${frame} > div:has(> [data-slot="sidebar"]){--dsw-specific-sidebar-fill:transparent;margin:var(--auralis-edge) calc(var(--auralis-gap) / 2) var(--auralis-edge) var(--auralis-edge);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--auralis-radius);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) ${a.glass ? 42 : 88}%,transparent)${blur}}`,
    `${frame} [data-slot="sidebar"] > div{max-width:100%}`,
    `${frame}[data-sidebar-collapsed] [data-slot="sidebar"] > div{--dsh-sidebar-inline-padding:4px}`,
    `${frame} > div:has(> [data-slot="main"]){margin:var(--auralis-edge) calc(var(--auralis-gap) / 2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--auralis-radius);background:color-mix(in srgb,var(--dsw-alias-bg-base) 64%,transparent)}`,
    `${frame}[data-rightbar-collapsed] > div:has(> [data-slot="main"]){margin-right:var(--auralis-edge)}`,
    `${frame} [data-slot="main.conversation"] > [data-phase]{background:transparent}`,
    `${frame} [data-sidebar-right-panel="push"][data-sidebar-right-open]{top:var(--auralis-edge);bottom:var(--auralis-edge);right:var(--auralis-edge);max-width:calc(100% - var(--auralis-edge) - var(--auralis-gap));box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--auralis-radius);background:var(--dsw-alias-bg-layer-1)${blur}}`,
    ...pages.automation ? [
      `${automation}{background:transparent}`,
      `${taskDetail}{background:color-mix(in srgb,var(--dsw-alias-bg-base) 38%,transparent)${blur}}`,
      `${taskDetail} :is(footer,p[role]){background:transparent}`,
      // 右栏标签宿主自身也是 bg-base 实色，只在承载任务详情时放开，其他右栏标签不动。
      `[data-dockkit-content]:has(${taskDetail}){background:transparent}`,
      // 搜索框只给圆角外框上色；内层 Input 外壳与 input 透明，避免框内叠出直角色块。
      `${taskSearch}{${field}}`,
      `${automation} :is(span:has(> input[type=search]),input[type=search]){background:transparent}`,
      `${taskInstruction}{${field}}`,
      `${taskMenuField}{${field}}`,
      // 卡片明暗两套各写死一组 static-neutral 实色变量，深色那条带 body[data-ds-dark-theme] 前缀，须同权重覆盖。
      `${taskCard}{${cardFill}${blur}}`,
      `body[data-ds-dark-theme] ${taskCard}{${cardFill}}`,
    ] : [],
    ...pages.settingsGlass ? [
      'div:has(> [data-shortcut-modal="settings"]){--dsw-mask-blur:blur(6px)}',
      // 模糊放在不接收事件的背景层，避免弹窗成为 fixed 拖拽浮层的定位包含块。
      `${settingsDialog}{background:transparent;backdrop-filter:none;isolation:isolate;border:1px solid #ffffff8c;box-shadow:inset 0 1px 0 #ffffffa6,0 18px 48px #0f2a4433;--dsw-alias-settings-card-fill:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent)}`,
      `${settingsDialog}::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;background:color-mix(in srgb,var(--dsw-alias-bg-base) 28%,transparent);backdrop-filter:blur(36px) saturate(170%)}`,
      `[data-ds-dark-theme] ${settingsDialog}{border-color:#ffffff1f;box-shadow:inset 0 1px 0 #ffffff14,0 18px 48px #0006}`,
      `[data-ds-dark-theme] ${settingsDialog}::before{background:color-mix(in srgb,var(--dsw-alias-bg-base) 38%,transparent)}`,
    ] : [],
    '@media(max-width:767px){',
    `${frame}{--auralis-edge:${Math.min(a.edge, 2)}px}`,
    '}',
    '@media(prefers-reduced-transparency:reduce){',
    `${frame} > div:has(> [data-slot="sidebar"]){background:var(--dsw-alias-bg-layer-1)}`,
    `${frame} > div:has(> [data-slot="main"]){background:var(--dsw-alias-bg-base)}`,
    ...pages.settingsGlass ? [`${settingsDialog}::before,[data-ds-dark-theme] ${settingsDialog}::before{background:var(--dsw-alias-bg-base);backdrop-filter:none}`] : [],
    ...pages.automation ? [
      `${taskDetail},${taskSearch},${taskInstruction},${taskMenuField}{background:var(--dsw-alias-bg-base);backdrop-filter:none}`,
      `${taskCard},body[data-ds-dark-theme] ${taskCard}{--card-fill:var(--dsw-alias-bg-layer-2);--card-hover:var(--dsw-alias-bg-layer-3);backdrop-filter:none}`,
    ] : [],
    '}',
  ].join('\n');
}
const surfaceStyles = buildSurfaceStyles();

const styles = `
.auralis-profile{position:relative;min-width:0;flex:1;font:inherit;color:var(--dsw-alias-label-primary)}
.auralis-profile-trigger{display:flex;align-items:center;gap:11px;width:100%;padding:9px 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background .16s,border-color .16s}
.auralis-profile-trigger:hover,.auralis-profile-trigger[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.auralis-profile-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.auralis-profile-avatar{position:relative;display:flex;flex:none;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);overflow:hidden}
.auralis-profile-avatar svg{display:block;width:36px;height:36px;image-rendering:pixelated}
.auralis-profile-avatar img{display:block;width:100%;height:100%;object-fit:cover}
.auralis-profile-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}
.auralis-profile-name{font-size:13px;font-weight:600;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.auralis-profile-subtitle{display:flex;align-items:center;gap:5px;font-size:10px;line-height:14px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.auralis-profile[data-source=account] .auralis-profile-subtitle::before{content:'';flex:none;width:6px;height:6px;border-radius:50%;background:#14b8a6;box-shadow:0 0 0 2px #14b8a626}
.auralis-profile-settings{display:flex;flex:none;align-items:center;color:var(--dsw-alias-label-secondary)}
.auralis-profile[data-rail=true] .auralis-profile-trigger{justify-content:center;padding:7px 1px}
.auralis-profile[data-rail=true] .auralis-profile-avatar{width:34px;height:34px;border-radius:50%}
@media(prefers-reduced-motion:reduce){.auralis-profile-trigger{transition:none}}
`;

const LOCAL_IDENTITY = resolveIdentity(normalize(DEFAULTS), undefined);

function createComponents(React) {
  const h = React.createElement;

  function PixelAvatar() {
    const pixels = [
      '................', '......hhhh......', '....hhhhhhhh....', '....hhsssshh....',
      '....hssssssh....', '....ssessess....', '.....ssssss.....', '......smms......',
      '.......ss.......', '.....tttttt.....', '....tttllttt....', '...stttllttts...',
      '...stttttttts...', '....tttttttt....', '.....pppppp.....', '.....pp..pp.....',
    ];
    const palette = { h: '#1f3a52', s: '#f1c7a3', e: '#1d3448', m: '#c97a6b', t: '#2f8fd8', l: '#a9d6f5', p: '#24557c' };
    return h('svg', { viewBox: '0 0 20 20', shapeRendering: 'crispEdges', 'aria-hidden': true, focusable: 'false' },
      h('rect', { width: 20, height: 20, fill: '#dcedfa' }),
      ...pixels.flatMap((row, y) => [...row].flatMap((color, x) => palette[color]
        ? [h('rect', { key: `${x}-${y}`, x: x + 2, y: y + 2, width: 1, height: 1, fill: palette[color] })] : [])));
  }

  /** 图片头像加载失败时回落到 fallback（账号头像 → 本地头像 → 像素小人）。 */
  function Avatar({ avatar }) {
    const [failed, setFailed] = React.useState(undefined);
    if (avatar?.kind === 'image' && failed !== avatar.src) {
      return h('img', { src: avatar.src, alt: '', draggable: false, referrerPolicy: 'no-referrer', onError: () => setFailed(avatar.src) });
    }
    if (avatar?.kind === 'image' && avatar.fallback) return h(Avatar, { avatar: avatar.fallback });
    return h(PixelAvatar);
  }

  function SettingsIcon() {
    return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
      h('path', { d: 'm10 3-.6 2.4-2 .9-2.2-.7L3 9.4 4.7 11v2L3 14.6l2.2 3.8 2.2-.7 2 .9L10 21h4l.6-2.4 2-.9 2.2.7 2.2-3.8-1.7-1.6v-2L21 9.4l-2.2-3.8-2.2.7-2-.9L14 3z' }),
      h('circle', { cx: 12, cy: 12, r: 3 }));
  }

  function ProfileLauncher({ wide, settingsOpen, openSettings, identity = LOCAL_IDENTITY }) {
    const label = `${identity.name} · 设置`;
    return h('div', { className: 'auralis-profile', 'data-rail': String(!wide), 'data-source': identity.source },
      h('style', null, styles),
      h('button', {
        type: 'button', className: 'auralis-profile-trigger',
        'aria-label': label, 'aria-haspopup': 'dialog', 'aria-expanded': settingsOpen,
        title: label, onClick: openSettings,
      }, h('span', { className: 'auralis-profile-avatar' }, h(Avatar, { avatar: identity.avatar })),
      wide ? h('span', { className: 'auralis-profile-copy' },
        h('span', { className: 'auralis-profile-name', 'data-auralis-nickname': true }, identity.name),
        identity.subtitle ? h('span', { className: 'auralis-profile-subtitle' }, identity.subtitle) : null) : null,
      wide ? h('span', { className: 'auralis-profile-settings', 'aria-hidden': true }, h(SettingsIcon)) : null));
  }
  function ThemeSurface({ css = surfaceStyles } = {}) {
    return h('style', { 'data-auralis-theme': true }, css);
  }
  return { PixelAvatar, Avatar, ProfileLauncher, ThemeSurface };
}

// 浏览器端单例：本插件只在一个页面上下文里激活一次。
let store;
const getStore = () => (store ??= createSettingsClient());

let components;
let page;
const ui = () => {
  const React = require('react');
  components ??= createComponents(React);
  page ??= createSettingsPage(React, { store: getStore(), components, resolveIdentity });
  return { React, components, page };
};
const useSnapshot = React => React.useSyncExternalStore(getStore().subscribe, getStore().getSnapshot);

function ProfileLauncher(props) {
  const { React, components: c } = ui();
  const snapshot = useSnapshot(React);
  const identity = resolveIdentity(snapshot.settings, snapshot.account);
  return React.createElement(c.ProfileLauncher, { ...props, identity });
}

function ThemeSurface() {
  const { React, components: c } = ui();
  const { settings, backgroundUrl } = useSnapshot(React);
  const css = React.useMemo(() => buildSurfaceStyles(settings, backgroundUrl), [settings, backgroundUrl]);
  return React.createElement(c.ThemeSurface, { css });
}

function SettingsPage(props) {
  const { React, page: p } = ui();
  return React.createElement(p.SettingsPage, props);
}

let usageView;
const usage = () => (usageView ??= createUsageView(require('react')));
function UsagePage() {
  return require('react').createElement(usage().UsagePage);
}
function UsageIcon(props) {
  return require('react').createElement(usage().UsageIcon, props);
}

/** 原「插件」入口的图标，沿用宿主风车图标。 */
function PluginCenterIcon({ size }) {
  const { IconPluginPinwheelOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
  return require('react').createElement(IconPluginPinwheelOutlineRegular, { size });
}

const PLUGINS_PANEL = 'plugins';
const USAGE_PANEL = 'auralis.usage';
const SETTINGS_SECTION = 'auralis';
// 同 id 下优先级更低者渲染（SlotCore「lowest renders」）；以 -1 遮蔽官方条目，停用本插件即恢复原样。
// 头像入口同理：官方账号界面也注册 settings.launcher（默认 0），同优先级会冲突。
const SHADOW = -1;

/**
 * 按偏好启停一组功能：`features` 为 `{ key: { wanted(settings), start() → dispose } }`。
 * 返回 `{ sync(settings), dispose() }`；同一功能只在开关翻转时注册或释放。
 */
function reconcileFeatures(features) {
  const active = new Map();
  return {
    sync(settings) {
      for (const [key, feature] of Object.entries(features)) {
        const wanted = feature.wanted(settings);
        if (wanted && !active.has(key)) active.set(key, feature.start());
        else if (!wanted && active.has(key)) {
          active.get(key)();
          active.delete(key);
        }
      }
    },
    dispose() {
      [...active.values()].reverse().forEach(dispose => dispose());
      active.clear();
    },
  };
}

/** 在 store 变化时驱动 reconcileFeatures，返回释放函数。 */
function bindFeatures(settingsStore, features) {
  const controller = reconcileFeatures(features);
  let last;
  const sync = () => {
    const { settings } = settingsStore.getSnapshot();
    if (settings === last) return;
    last = settings;
    controller.sync(settings);
  };
  sync();
  const unsubscribe = settingsStore.subscribe(sync);
  return () => {
    unsubscribe();
    controller.dispose();
  };
}

const inject = ['theme', 'slots'];
function apply(ctx) {
  const { slots } = ctx;
  const settingsStore = getStore();
  const slot = (name, options, component) => () => slots.inject(name, () => slots.register({ name, ...options }, component));
  ctx.effect(() => bindFeatures(settingsStore, {
    tokens: { wanted: s => s.appearance.enabled, start: () => ctx.theme.overrideTokens('auralis', themeTokens) },
    launcher: { wanted: s => s.nav.launcher, start: slot('settings.launcher', { priority: SHADOW }, ProfileLauncher) },
    surface: { wanted: s => s.appearance.enabled, start: slot('shell.overlay', { id: 'auralis.theme' }, ThemeSurface) },
    pluginCenter: {
      wanted: s => s.nav.pluginCenter,
      start: slot('sidebar.panellist', { id: PLUGINS_PANEL, order: 0, priority: SHADOW, label: '插件中心' }, PluginCenterIcon),
    },
  }), 'auralis: preference-driven features');
  // 设置页签常驻，关掉的功能可随时在这里打开。
  ctx.effect(slot('settings.section', { id: SETTINGS_SECTION, order: 50, label: 'Auralis' }, SettingsPage), 'auralis: settings section');
  ctx.effect(() => {
    settingsStore.load();
    return () => settingsStore.flush();
  }, 'auralis: shared preferences');
  // 主面板与侧栏入口须在 layout 就绪后登记，写法与官方 QQ 插件一致。
  ctx.inject(['layout'], layoutCtx => bindFeatures(settingsStore, {
    usage: {
      wanted: s => s.usage.enabled,
      start() {
        const stopMain = layoutCtx.slots.inject('main', () => layoutCtx.slots.register({ name: 'main', key: USAGE_PANEL }, UsagePage));
        const stopEntry = layoutCtx.slots.inject('sidebar.panellist', () => layoutCtx.slots.register({
          name: 'sidebar.panellist', id: USAGE_PANEL, order: 1, label: '使用分析',
        }, UsageIcon));
        return () => {
          stopEntry();
          stopMain();
        };
      },
    },
  }));
  // 账号状态与官方账号界面无关，由宿主账号控制器提供；不可用时头像入口保持本地资料。
  ctx.inject(['remote', 'remote.account', 'locale'], accountCtx => watchAccount(accountCtx, settingsStore));
}

module.exports = {
  inject, apply, themeTokens, createComponents, surfaceStyles, buildSurfaceStyles, wallpaper, reconcileFeatures, bindFeatures,
  PLUGINS_PANEL, USAGE_PANEL, SETTINGS_SECTION,
};
