/**
 * Auralis 设置的服务端：偏好与自定义背景存于 profile 目录下的插件自有数据目录，所有浏览器共享；
 * 另提供白名单内的三个官方开关（账号界面、消息反馈、模型首次引导）。
 * 核心：createSettingsStore（原子读写偏好与背景）、createHostControls（官方开关）、registerSettingsRoutes。
 * 路由均走 Connection 鉴权（仅 owner）；只接受 GET / POST。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { DEFAULTS, LIMITS, mergePatch, normalize, sniffImage } = require('./settings-model.cjs');

export const SETTINGS_PATH = '/api/auralis.settings';
export const BACKGROUND_PATH = '/api/auralis.background';
export const HOST_PATH = '/api/auralis.host';

/** 官方开关白名单；`bundle` 是本插件补丁给出的默认值，「恢复默认」即回到这些值。 */
export const HOST_TOGGLES = {
  account: { kind: 'plugin', patchId: 'ui-settings-account', bundle: false },
  feedback: { kind: 'plugin', patchId: 'ui-message-feedback', bundle: false },
  onboarding: { kind: 'config', patchId: 'ui-settings-models', field: 'credentialOnboarding', bundle: false },
};

const NO_STORE = { 'cache-control': 'no-store' };
const jsonError = (status, error) => Response.json({ error }, { status, headers: NO_STORE });

async function atomicWrite(path, data) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, path);
}

async function readOptional(path, encoding) {
  try {
    return await readFile(path, encoding);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** 偏好存 settings.json，背景存单独的 background.bin；写入串行，避免并发请求互相覆盖。 */
export function createSettingsStore(dir) {
  const settingsFile = join(dir, 'settings.json');
  const backgroundFile = join(dir, 'background.bin');
  let queue = Promise.resolve();
  const serial = task => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };
  async function read() {
    const raw = await readOptional(settingsFile, 'utf8');
    if (raw === undefined) return normalize(DEFAULTS);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 损坏的偏好文件不阻断页面：回落默认值，下次保存时覆盖。
      console.warn('[auralis] settings.json is not valid JSON; defaults are used until the next save');
      return normalize(DEFAULTS);
    }
    return normalize(parsed);
  }
  async function write(settings) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWrite(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  }
  return {
    dir,
    read,
    update: patch => serial(async () => write(mergePatch(await read(), patch))),
    reset: () => serial(async () => {
      const current = await read();
      // 背景是否保留由单独的「恢复默认背景」控制；这里只重置偏好，但保留 rev 以免浏览器命中旧缓存。
      return write(mergePatch(normalize(DEFAULTS), { background: current.background }, { trusted: true }));
    }),
    async readBackground() {
      const settings = await read();
      if (!settings.background.custom) return undefined;
      const bytes = await readOptional(backgroundFile);
      return bytes && { bytes, type: settings.background.type };
    },
    saveBackground: (bytes, type) => serial(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await atomicWrite(backgroundFile, bytes);
      const current = await read();
      return write(mergePatch(current, { background: { custom: true, type, rev: current.background.rev + 1 } }, { trusted: true }));
    }),
    clearBackground: () => serial(async () => {
      await rm(backgroundFile, { force: true });
      const current = await read();
      return write(mergePatch(current, { background: { custom: false, type: '', rev: current.background.rev + 1 } }, { trusted: true }));
    }),
  };
}

/**
 * 白名单官方开关。插件启停走 pluginManager，配置项走 configEditor；两者都写 profile 用户层补丁，
 * 因此卸载 Auralis 后仍保留，需要「恢复默认」显式清回。服务缺失时对应开关标记为 unavailable。
 */
export function createHostControls(ctx) {
  const services = () => ({ editor: ctx.get('configEditor'), manager: ctx.get('pluginManager') });
  const configEntry = (editor, patchId) => editor?.entries().find(entry => entry.options.id === patchId);

  async function state() {
    const { editor, manager } = services();
    const rows = manager ? await manager.listPlugins() : [];
    const result = {};
    for (const [key, toggle] of Object.entries(HOST_TOGGLES)) {
      if (toggle.kind === 'plugin') {
        const row = rows.find(item => item.patchId === toggle.patchId);
        result[key] = row
          ? { available: row.readOnlyReason === undefined, enabled: row.enabled, bundle: toggle.bundle, ...row.readOnlyReason ? { reason: row.readOnlyReason } : {} }
          : { available: false, enabled: undefined, bundle: toggle.bundle, reason: manager ? 'not-found' : 'no-plugin-manager' };
      } else {
        const entry = configEntry(editor, toggle.patchId);
        result[key] = entry
          ? { available: true, enabled: entry.options.config?.[toggle.field] !== false, bundle: toggle.bundle }
          : { available: false, enabled: undefined, bundle: toggle.bundle, reason: editor ? 'not-found' : 'no-config-editor' };
      }
    }
    return result;
  }

  /** @returns 结果说明 `{ key, application, restartReason?, error? }`，application 取值同 pluginManager。 */
  async function set(key, enabled, { reset = false } = {}) {
    const toggle = HOST_TOGGLES[key];
    const { editor, manager } = services();
    if (toggle.kind === 'plugin') {
      if (!manager) return { key, application: 'failed', error: { code: 'no-plugin-manager' } };
      const row = (await manager.listPlugins()).find(item => item.patchId === toggle.patchId);
      if (!row) return { key, application: 'failed', error: { code: 'not-found' } };
      if (row.readOnlyReason !== undefined) return { key, application: 'failed', error: { code: row.readOnlyReason } };
      const change = await manager.setPluginEnabled(row.entryId, enabled);
      return { key, application: change.application, ...change.restartReason ? { restartReason: change.restartReason } : {}, ...change.error ? { error: change.error } : {} };
    }
    const entry = configEntry(editor, toggle.patchId);
    if (!entry) return { key, application: 'failed', error: { code: editor ? 'not-found' : 'no-config-editor' } };
    try {
      // 与继承层相同的值会被 configEditor 自动清出用户层，「恢复默认」由此不留冗余条目。
      await editor.edit(entry, (current, inherited) => reset ? inherited : { ...current, [toggle.field]: enabled });
    } catch (error) {
      return { key, application: 'failed', error: { code: 'operation-error', diagnostic: String(error?.message ?? error).slice(0, 240) } };
    }
    // 首次引导的开关在页面加载时读取，需刷新页面。
    return { key, application: 'reload-required' };
  }

  async function resetAll() {
    const results = [];
    for (const [key, toggle] of Object.entries(HOST_TOGGLES)) results.push(await set(key, toggle.bundle, { reset: true }));
    return results;
  }
  return { state, set, resetAll };
}

const isJson = request => (request.headers.get('content-type') ?? '').split(';')[0].trim() === 'application/json';
async function readJson(request, limit) {
  if (!isJson(request)) return { error: jsonError(415, 'expected-json') };
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > limit) return { error: jsonError(413, 'too-large') };
  try {
    return { value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { error: jsonError(400, 'invalid-json') };
  }
}

/** 构造三个路由处理函数；与 ctx 解耦，便于测试。 */
export function createSettingsHandlers(store, host) {
  return {
    async settings(request) {
      if (request.method === 'GET') return Response.json({ settings: await store.read() }, { headers: NO_STORE });
      const { value, error } = await readJson(request, LIMITS.settingsBytes);
      if (error) return error;
      if (value?.reset === true) return Response.json({ settings: await store.reset() }, { headers: NO_STORE });
      if (value === null || typeof value !== 'object' || typeof value.patch !== 'object' || value.patch === null) return jsonError(400, 'expected-patch');
      return Response.json({ settings: await store.update(value.patch) }, { headers: NO_STORE });
    },
    async background(request) {
      if (request.method === 'GET') {
        const image = await store.readBackground();
        if (!image) return new Response(null, { status: 404, headers: NO_STORE });
        // 地址带版本号，替换背景时版本号递增，因此可长缓存。
        return new Response(image.bytes, { headers: { 'content-type': image.type, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
      }
      const type = (request.headers.get('content-type') ?? '').split(';')[0].trim();
      if (type === 'application/json') {
        const { value, error } = await readJson(request, 1024);
        if (error) return error;
        if (value?.reset !== true) return jsonError(400, 'expected-reset');
        return Response.json({ settings: await store.clearBackground() }, { headers: NO_STORE });
      }
      const declared = Number(request.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > LIMITS.backgroundBytes) return jsonError(413, 'too-large');
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0) return jsonError(400, 'empty');
      if (bytes.byteLength > LIMITS.backgroundBytes) return jsonError(413, 'too-large');
      const sniffed = sniffImage(bytes);
      if (!sniffed || sniffed !== type) return jsonError(415, 'unsupported-image');
      return Response.json({ settings: await store.saveBackground(bytes, sniffed) }, { headers: NO_STORE });
    },
    async host(request) {
      if (request.method === 'GET') return Response.json({ host: await host.state() }, { headers: NO_STORE });
      const { value, error } = await readJson(request, 1024);
      if (error) return error;
      let results;
      if (value?.reset === true) results = await host.resetAll();
      else if (Object.hasOwn(HOST_TOGGLES, value?.key) && typeof value.enabled === 'boolean') results = [await host.set(value.key, value.enabled)];
      else return jsonError(400, 'expected-toggle');
      return Response.json({ results, host: await host.state() }, { headers: NO_STORE });
    },
  };
}

/** 注册鉴权路由；数据目录为 `<profile>/data/auralis`，属本插件自有。 */
export function registerSettingsRoutes(ctx) {
  const store = createSettingsStore(join(ctx.profileContext.dir, 'data', 'auralis'));
  const handlers = createSettingsHandlers(store, createHostControls(ctx));
  for (const [path, fetch] of [[SETTINGS_PATH, handlers.settings], [BACKGROUND_PATH, handlers.background], [HOST_PATH, handlers.host]]) {
    ctx.connection.fetch.register({ path, methods: ['GET', 'POST'], requestBody: 'buffered', fetch });
  }
}
