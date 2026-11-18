/**
 * Auralis 偏好模型，浏览器与服务端共用。
 * 核心：DEFAULTS（默认值）、normalize（任意输入 → 合法偏好，越界值回落或钳制）、
 * mergePatch（按分组浅合并后再规范化）、sniffImage（按魔数识别 PNG / JPEG / WebP）。
 */
'use strict';

const LIMITS = {
  // 背景原图上限；服务端按字节与魔数双重校验，浏览器先行提示。
  backgroundBytes: 8 * 1024 * 1024,
  // 本地头像在浏览器端缩放成 128px 后以 data URL 存入偏好。
  avatarChars: 256 * 1024,
  // 偏好 JSON 请求体上限（含头像 data URL）。
  settingsBytes: 400 * 1024,
  nameChars: 24,
  subtitleChars: 40,
};

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const DEFAULTS = Object.freeze({
  appearance: Object.freeze({ enabled: true, glass: true, veil: 28, veilDark: 58, gap: 2, edge: 4 }),
  background: Object.freeze({ custom: false, type: '', rev: 0 }),
  nav: Object.freeze({ launcher: true, pluginCenter: true }),
  usage: Object.freeze({ enabled: true }),
  pages: Object.freeze({ automation: true, settingsGlass: true }),
  profile: Object.freeze({ name: 'Kared', subtitle: '个人工作台', avatar: 'pixel', preferAccount: true }),
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const flag = (value, fallback) => typeof value === 'boolean' ? value : fallback;
function integer(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}
function text(value, fallback, max, allowEmpty) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean && !allowEmpty) return fallback;
  return [...clean].slice(0, max).join('');
}
const AVATAR_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
function avatar(value) {
  if (value === 'pixel') return value;
  return typeof value === 'string' && value.length <= LIMITS.avatarChars && AVATAR_PATTERN.test(value) ? value : DEFAULTS.profile.avatar;
}

/** 把任意输入规范成完整偏好；未知字段丢弃，类型不符回落默认，数值钳制在可用区间。 */
function normalize(raw) {
  const source = isObject(raw) ? raw : {};
  const group = name => isObject(source[name]) ? source[name] : {};
  const [a, b, n, u, p, f] = ['appearance', 'background', 'nav', 'usage', 'pages', 'profile'].map(group);
  const d = DEFAULTS;
  const custom = flag(b.custom, false) && IMAGE_TYPES.includes(b.type);
  return {
    appearance: {
      enabled: flag(a.enabled, d.appearance.enabled),
      glass: flag(a.glass, d.appearance.glass),
      veil: integer(a.veil, d.appearance.veil, 0, 90),
      veilDark: integer(a.veilDark, d.appearance.veilDark, 0, 90),
      gap: integer(a.gap, d.appearance.gap, 0, 16),
      edge: integer(a.edge, d.appearance.edge, 0, 16),
    },
    background: { custom, type: custom ? b.type : '', rev: integer(b.rev, 0, 0, Number.MAX_SAFE_INTEGER) },
    nav: { launcher: flag(n.launcher, d.nav.launcher), pluginCenter: flag(n.pluginCenter, d.nav.pluginCenter) },
    usage: { enabled: flag(u.enabled, d.usage.enabled) },
    pages: { automation: flag(p.automation, d.pages.automation), settingsGlass: flag(p.settingsGlass, d.pages.settingsGlass) },
    profile: {
      name: text(f.name, d.profile.name, LIMITS.nameChars, false),
      subtitle: text(f.subtitle, d.profile.subtitle, LIMITS.subtitleChars, true),
      avatar: avatar(f.avatar),
      preferAccount: flag(f.preferAccount, d.profile.preferAccount),
    },
  };
}

/** 按分组浅合并补丁；`background` 只能由服务端改写，浏览器补丁里的该字段被忽略。 */
function mergePatch(current, patch, { trusted = false } = {}) {
  const base = normalize(current);
  if (!isObject(patch)) return base;
  const next = { ...base };
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'background' && !trusted) continue;
    if (isObject(patch[key])) next[key] = { ...base[key], ...patch[key] };
  }
  return normalize(next);
}

/** 依据文件头识别图片类型；不认识返回 undefined。 */
function sniffImage(bytes) {
  const at = (offset, values) => values.every((value, index) => bytes[offset + index] === value);
  if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return undefined;
}

module.exports = { DEFAULTS, LIMITS, IMAGE_TYPES, normalize, mergePatch, sniffImage };
