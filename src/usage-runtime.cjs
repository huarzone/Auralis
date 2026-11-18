/** 使用分析的浏览器 I/O：串行轮询与可降级的范围记忆；依赖可注入以离线验证生命周期。 */
'use strict';

const { USAGE_ROUTE } = require('./usage-data.cjs');

function readPreference(storage, key, fallback, allowed, warn = console.warn) {
  try {
    const value = storage?.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch (error) {
    warn(`无法读取看板偏好：${error.message}`);
    return fallback;
  }
}

function savePreference(storage, key, value) {
  try {
    storage?.setItem(key, value);
    return undefined;
  } catch (error) {
    return `本次选择仍然生效，但无法记住：${error.message}`;
  }
}

/** 一次请求完成后才设下一次定时器；隐藏时不发新请求，停止后丢弃全部迟到结果。 */
function startUsagePolling({
  interval, onData, onError, onLoading,
  fetcher = globalThis.fetch, document = globalThis.document,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
}) {
  let stopped = false;
  let pending = false;
  let timer;
  const controller = new AbortController();
  const visible = () => document.visibilityState === 'visible';
  const clear = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  async function refresh() {
    if (stopped || pending || !visible()) return;
    clear();
    pending = true;
    onLoading(true);
    try {
      const response = await fetcher(USAGE_ROUTE, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      if (!stopped) {
        onData(snapshot);
        onError(undefined);
      }
    } catch (error) {
      if (!stopped) onError(String(error?.message ?? error));
    } finally {
      pending = false;
      if (!stopped) {
        onLoading(false);
        if (visible()) timer = setTimer(refresh, interval);
      }
    }
  }
  function visibilityChanged() {
    clear();
    if (visible()) refresh();
  }
  document.addEventListener('visibilitychange', visibilityChanged);
  refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clear();
      controller.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
    },
  };
}

module.exports = { readPreference, savePreference, startUsagePolling };
