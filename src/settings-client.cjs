/**
 * Auralis 浏览器端设置状态：服务端偏好（全部浏览器共享）、自定义背景、官方开关与登录账号。
 * 核心：createSettingsClient（可订阅的设置仓库，乐观更新 + 合并防抖保存）、watchAccount（订阅宿主账号流）、
 * resolveIdentity（登录显示账号资料，未登录显示本地资料）。
 */
'use strict';

const { DEFAULTS, LIMITS, IMAGE_TYPES, mergePatch, normalize } = require('./settings-model.cjs');

const SETTINGS_ROUTE = 'api/auralis.settings';
const BACKGROUND_ROUTE = 'api/auralis.background';
const HOST_ROUTE = 'api/auralis.host';
// 上次从服务端拿到的偏好，仅用于首屏避免闪烁；以服务端为准。
const CACHE_KEY = 'auralis.settings.cache';
const SAVE_DELAY = 350;
const CLIENT_VERSION = '0.2.1-rc.5';

function readCache(storage) {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    return raw ? normalize(JSON.parse(raw)) : undefined;
  } catch (error) {
    console.warn('[auralis] settings cache unreadable', error);
    return undefined;
  }
}

function createSettingsClient({ fetch = (...args) => globalThis.fetch(...args), storage = globalThis.localStorage, urls = globalThis.URL } = {}) {
  const listeners = new Set();
  let state = {
    settings: readCache(storage) ?? normalize(DEFAULTS),
    ready: false, saving: false, error: '',
    backgroundUrl: undefined,
    host: undefined, hostBusy: '', hostNotes: {}, hostError: '',
    account: { status: 'unavailable' },
  };
  let pending;
  let timer;
  let flushing = Promise.resolve();
  let backgroundRev;
  let backgroundRequest = 0;

  const emit = () => listeners.forEach(listener => listener());
  function set(partial) {
    state = { ...state, ...partial };
    emit();
  }
  function writeCache(settings) {
    try {
      storage?.setItem(CACHE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('[auralis] settings cache not written', error);
    }
  }
  function applyServer(settings) {
    const next = normalize(settings);
    // 仍有未发出的本地修改时，以本地为准叠加在服务端结果之上，避免回跳。
    const shown = pending ? mergePatch(next, pending) : next;
    writeCache(next);
    set({ settings: shown, ready: true });
    syncBackground(next.background);
  }

  async function request(path, init = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...init });
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : undefined;
    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
    return body;
  }
  const post = (path, value) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

  async function syncBackground(background) {
    if (!background.custom) {
      backgroundRev = undefined;
      backgroundRequest++;
      if (state.backgroundUrl) urls.revokeObjectURL(state.backgroundUrl);
      if (state.backgroundUrl !== undefined) set({ backgroundUrl: undefined });
      return;
    }
    if (backgroundRev === background.rev) return;
    backgroundRev = background.rev;
    const id = ++backgroundRequest;
    try {
      const response = await fetch(`${BACKGROUND_ROUTE}?v=${background.rev}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const url = urls.createObjectURL(await response.blob());
      if (id !== backgroundRequest) return urls.revokeObjectURL(url);
      if (state.backgroundUrl) urls.revokeObjectURL(state.backgroundUrl);
      set({ backgroundUrl: url });
    } catch (error) {
      if (id !== backgroundRequest) return;
      backgroundRev = undefined;
      set({ error: `背景读取失败：${error.message}` });
    }
  }

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!pending) return flushing;
    const patch = pending;
    pending = undefined;
    flushing = flushing.then(async () => {
      set({ saving: true });
      try {
        applyServer((await post(SETTINGS_ROUTE, { patch })).settings);
        set({ saving: false, error: '' });
      } catch (error) {
        set({ saving: false, error: `保存失败：${error.message}` });
        await load();
      }
    });
    return flushing;
  }

  async function load() {
    try {
      applyServer((await request(SETTINGS_ROUTE)).settings);
    } catch (error) {
      set({ ready: true, error: `读取设置失败：${error.message}` });
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    flush,
    /** 立即应用到界面，合并后延迟保存；连续拖动滑块只发一次请求。 */
    update(patch) {
      pending = pending ? Object.fromEntries(Object.keys(DEFAULTS).filter(key => pending[key] || patch[key])
        .map(key => [key, { ...pending[key], ...patch[key] }])) : patch;
      set({ settings: mergePatch(state.settings, patch) });
      clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY);
    },
    async reset() {
      clearTimeout(timer);
      pending = undefined;
      await flushing;
      try {
        applyServer((await post(SETTINGS_ROUTE, { reset: true })).settings);
        set({ error: '' });
      } catch (error) {
        set({ error: `恢复默认失败：${error.message}` });
      }
    },
    async uploadBackground(file) {
      if (!IMAGE_TYPES.includes(file.type)) return set({ error: '背景仅支持 PNG、JPEG 或 WebP。' });
      if (file.size > LIMITS.backgroundBytes) return set({ error: `背景不能超过 ${LIMITS.backgroundBytes / 1024 / 1024} MB。` });
      set({ saving: true });
      try {
        applyServer((await request(BACKGROUND_ROUTE, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })).settings);
        set({ saving: false, error: '' });
      } catch (error) {
        set({ saving: false, error: `背景上传失败：${error.message}` });
      }
    },
    async clearBackground() {
      try {
        applyServer((await post(BACKGROUND_ROUTE, { reset: true })).settings);
        set({ error: '' });
      } catch (error) {
        set({ error: `恢复默认背景失败：${error.message}` });
      }
    },
    async loadHost() {
      try {
        set({ host: (await request(HOST_ROUTE)).host, hostError: '' });
      } catch (error) {
        set({ hostError: `读取官方开关失败：${error.message}` });
      }
    },
    async setHost(key, enabled) {
      set({ hostBusy: key, hostError: '' });
      try {
        const { results, host } = await post(HOST_ROUTE, { key, enabled });
        set({ host, hostNotes: { ...state.hostNotes, [key]: results[0] } });
      } catch (error) {
        set({ hostError: `修改失败：${error.message}` });
      } finally {
        set({ hostBusy: '' });
      }
    },
    async resetHost() {
      set({ hostBusy: 'reset', hostError: '' });
      try {
        const { results, host } = await post(HOST_ROUTE, { reset: true });
        set({ host, hostNotes: Object.fromEntries(results.map(result => [result.key, result])) });
      } catch (error) {
        set({ hostError: `恢复失败：${error.message}` });
      } finally {
        set({ hostBusy: '' });
      }
    },
    setAccount(account) {
      set({ account });
    },
    dispose() {
      clearTimeout(timer);
      backgroundRequest++;
      if (state.backgroundUrl) urls.revokeObjectURL(state.backgroundUrl);
      listeners.clear();
    },
  };
}

/**
 * 订阅宿主账号状态；`credential-stored` 只代表本机存有凭据，资料读取失败时仍按已登录显示、头像回落本地。
 * @returns 释放函数。
 */
function watchAccount(ctx, client) {
  let disposed = false;
  let generation = 0;
  const stream = ctx.remote.$stream({
    name: 'auralis-account',
    open: signal => ctx.remote.account.watch(signal),
    ended: () => new Error('Account stream ended'),
  });
  const meta = () => ({ version: CLIENT_VERSION, locale: ctx.locale.getSnapshot().active, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
  async function readProfile(id) {
    let result;
    try {
      result = await ctx.remote.account.getProfile(meta());
    } catch (error) {
      console.warn('[auralis] account profile unavailable', error);
    }
    if (disposed || id !== generation) return;
    const profile = result?.ok && result.value?.status === 'ready' ? result.value.value : undefined;
    client.setAccount({ status: 'signed-in', profile });
  }
  client.setAccount({ status: 'loading' });
  (async () => {
    for await (const frame of stream) {
      const view = frame.value;
      frame.accept();
      const id = ++generation;
      if (view?.status === 'credential-stored') {
        client.setAccount({ status: 'signed-in' });
        readProfile(id);
      } else client.setAccount({ status: view?.status === 'signed-out' ? 'signed-out' : 'loading' });
    }
  })().catch(error => {
    if (disposed) return;
    console.error('[auralis] account stream failed', error);
    client.setAccount({ status: 'error' });
  });
  return () => {
    disposed = true;
    generation++;
    client.setAccount({ status: 'unavailable' });
    return stream.dispose();
  };
}

/** 登录且允许时显示账号；其余（未登录、读取中、出错、关闭）显示本地资料。 */
function resolveIdentity(settings, account) {
  const local = settings.profile;
  const localAvatar = local.avatar === 'pixel' ? { kind: 'pixel' } : { kind: 'image', src: local.avatar };
  if (local.preferAccount && account?.status === 'signed-in') {
    const profile = account.profile;
    return {
      source: 'account',
      name: profile?.name || profile?.contact || '已登录账号',
      subtitle: 'DeepSeek 账号',
      avatar: profile?.avatarUrl ? { kind: 'image', src: profile.avatarUrl, fallback: localAvatar } : localAvatar,
    };
  }
  return { source: 'local', name: local.name, subtitle: local.subtitle, avatar: localAvatar };
}

module.exports = { createSettingsClient, watchAccount, resolveIdentity, SETTINGS_ROUTE, BACKGROUND_ROUTE, HOST_ROUTE, CACHE_KEY };
