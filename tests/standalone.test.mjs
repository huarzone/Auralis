/** 独立插件边界：包身份、模块范围、默认鉴权，以及与旧插件数据和浏览器偏好的隔离。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function requiredPath(relative) {
  const path = join(root, relative);
  assert.ok(existsSync(path), `Auralis must provide ${relative}`);
  return path;
}

async function serverFixture(profileDir) {
  const plugin = await import(pathToFileURL(requiredPath('src/index.mjs')).href);
  const routes = [];
  plugin.apply({
    connection: { fetch: { register: route => routes.push(route) } },
    profileContext: { dir: profileDir },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get: () => undefined,
  });
  return { plugin, routes };
}

async function tempProfile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'auralis-standalone-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('standalone package has its own identity and no third-party dependencies', async () => {
  const pkg = JSON.parse(await readFile(requiredPath('package.json'), 'utf8'));
  assert.equal(pkg.name, 'auralis');
  assert.equal(pkg.version, '0.1.2');
  assert.equal(pkg.type, 'module');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(Object.keys(pkg[field] ?? {}), [], field);
  }
  assert.equal(pkg.exports['.'], './src/index.mjs');
  assert.equal(pkg.exports['./client'], './dist/client.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});

test('package admits the new DSH release and retains support for the rollback release', async () => {
  const pkg = JSON.parse(await readFile(requiredPath('package.json'), 'utf8'));
  assert.equal(pkg.engines.dsh, '0.2.1-rc.5 || 0.2.2-rc.4');
});

test('standalone source contains theme, usage and settings but no workspace modules', async () => {
  const src = requiredPath('src');
  const names = await readdir(src, { recursive: true });
  for (const name of ['client.cjs', 'usage-server.mjs', 'usage-view.cjs', 'settings-server.mjs', 'settings-page.cjs']) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(names.every(name => !/(?:^|\/)(?:assets?|creative|studio|motion|execution)(?:[-./]|$)/.test(name)), names.join('\n'));
  const entry = await readFile(requiredPath('src/index.mjs'), 'utf8');
  assert.doesNotMatch(entry, /assets|creative|studio|motion|execution/i);
});

test('server entry registers exactly four Auralis routes with Connection default authentication', async t => {
  const { plugin, routes } = await serverFixture(await tempProfile(t));
  assert.equal(plugin.name, 'auralis');
  assert.deepEqual(plugin.inject, ['connection', 'sessionQuery', 'profileContext']);
  assert.deepEqual(routes.map(route => route.path).sort(), [
    '/api/auralis.background', '/api/auralis.host', '/api/auralis.settings', '/api/auralis.usage',
  ]);
  for (const route of routes) {
    assert.equal(Object.hasOwn(route, 'auth'), false, `${route.path} must preserve Connection default auth`);
    assert.equal(route.requestBody, 'buffered');
    assert.deepEqual(route.methods, route.path.endsWith('.usage') ? ['GET'] : ['GET', 'POST']);
    assert.equal(typeof route.fetch, 'function');
  }
  const usage = await routes.find(route => route.path.endsWith('.usage')).fetch(new Request('http://test/api/auralis.usage'));
  assert.equal(usage.status, 200);
  assert.equal(usage.headers.get('cache-control'), 'no-store');
  const snapshot = await usage.json();
  assert.deepEqual(snapshot.calls, []);
  assert.deepEqual(snapshot.sessions, []);
});

test('real route handlers use data/auralis without inheriting or changing legacy profile data', async t => {
  const profile = await tempProfile(t);
  const legacy = join(profile, 'data', 'draflow-studio');
  const current = join(profile, 'data', 'auralis');
  await mkdir(legacy, { recursive: true });
  const oldSettings = JSON.stringify({ profile: { name: 'legacy-only-profile' }, usage: { enabled: false }, background: { custom: true, type: 'image/webp', rev: 41 } });
  const oldBackground = Uint8Array.from([...WEBP, 1, 2, 3]);
  await writeFile(join(legacy, 'settings.json'), oldSettings);
  await writeFile(join(legacy, 'background.bin'), oldBackground);
  const { routes } = await serverFixture(profile);
  const request = (name, init) => routes.find(route => route.path === `/api/auralis.${name}`).fetch(new Request(`http://test/api/auralis.${name}`, init));
  const initial = await (await request('settings')).json();
  assert.notEqual(initial.settings.profile.name, 'legacy-only-profile');
  assert.equal(initial.settings.usage.enabled, true);
  assert.deepEqual(initial.settings.background, { custom: false, type: '', rev: 0 });
  assert.equal((await request('background')).status, 404, 'legacy background must not be read');
  const saved = await request('settings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { profile: { name: 'Auralis-only-profile' } } }),
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(await readFile(join(current, 'settings.json'), 'utf8')).profile.name, 'Auralis-only-profile');
  const uploaded = await request('background', { method: 'POST', headers: { 'content-type': 'image/webp' }, body: WEBP });
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).settings.background.rev, 1);
  assert.deepEqual(new Uint8Array(await readFile(join(current, 'background.bin'))), WEBP);
  assert.deepEqual(new Uint8Array(await (await request('background')).arrayBuffer()), WEBP);
  assert.equal(await readFile(join(legacy, 'settings.json'), 'utf8'), oldSettings);
  assert.deepEqual(new Uint8Array(await readFile(join(legacy, 'background.bin'))), oldBackground);
  assert.deepEqual((await readdir(legacy)).sort(), ['background.bin', 'settings.json']);
  assert.deepEqual((await readdir(join(profile, 'data'))).sort(), ['auralis', 'draflow-studio']);
});

test('browser settings cache and usage preferences never read or overwrite legacy keys', async t => {
  const { createSettingsClient, CACHE_KEY } = require(requiredPath('src/settings-client.cjs'));
  const { normalize, DEFAULTS } = require(requiredPath('src/settings-model.cjs'));
  const values = new Map([
    ['draflow.settings.cache', JSON.stringify({ profile: { name: 'legacy-browser-profile' } })],
    ['draflow.usage.range', 'all'], ['draflow.usage.period', 'year'],
  ]);
  const legacy = new Map(values);
  const reads = [];
  const writes = [];
  const storage = {
    getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { writes.push(key); values.set(key, String(value)); },
  };
  assert.equal(CACHE_KEY, 'auralis.settings.cache');
  const client = createSettingsClient({
    storage,
    fetch: async path => {
      assert.equal(path, 'api/auralis.settings');
      return Response.json({ settings: normalize(DEFAULTS) });
    },
  });
  t.after(() => client.dispose());
  assert.notEqual(client.getSnapshot().settings.profile.name, 'legacy-browser-profile');
  await client.load();
  assert.ok(values.has('auralis.settings.cache'));
  const viewPath = requiredPath('src/usage-view.cjs');
  const module = { exports: {} };
  runInNewContext(await readFile(viewPath, 'utf8'), {
    module, require: createRequire(pathToFileURL(viewPath)), localStorage: storage,
  });
  let index = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: initial => [index++ === 0 ? { sessions: [], calls: [], skipped: [], generatedAt: Date.now() } : typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect() {}, useMemo: fn => fn(), useRef: value => ({ current: value }), useId: () => 'standalone',
  };
  function render(node) {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }));
    return { ...node, children: node.children.map(render) };
  }
  function find(tree, predicate) {
    if (!tree || typeof tree !== 'object') return [];
    return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => find(child, predicate))];
  }
  const { UsagePage } = module.exports.createUsageView(React);
  const tree = render(UsagePage());
  for (const [label, choice] of [['时间范围', '60 分钟'], ['活动热力图周期', '月']]) {
    const group = find(tree, node => node.props['aria-label'] === label)[0];
    const button = find(group, node => node.type === 'button' && node.children.includes(choice))[0];
    assert.ok(button, `${label}: ${choice}`);
    button.props.onClick();
  }
  assert.ok(reads.includes('auralis.settings.cache'));
  assert.ok(reads.includes('auralis.usage.range'));
  assert.ok(reads.includes('auralis.usage.period'));
  assert.deepEqual(writes.sort(), ['auralis.settings.cache', 'auralis.usage.period', 'auralis.usage.range']);
  assert.equal(values.get('auralis.usage.range'), '1h');
  assert.equal(values.get('auralis.usage.period'), 'month');
  assert.ok(reads.every(key => key.startsWith('auralis.')));
  for (const [key, value] of legacy) assert.equal(values.get(key), value, key);
});
