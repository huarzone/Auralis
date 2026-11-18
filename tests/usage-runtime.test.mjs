import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { startUsagePolling, readPreference, savePreference } = require('../src/usage-runtime.cjs');

function fixture(fetcher) {
  const timers = new Map();
  const listeners = new Map();
  let serial = 0;
  const document = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  const data = [];
  const errors = [];
  const busy = [];
  const poll = startUsagePolling({
    fetcher, document, interval: 10_000,
    setTimer: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; },
    clearTimer: id => timers.delete(id),
    onData: value => data.push(value), onError: value => errors.push(value), onLoading: value => busy.push(value),
  });
  return {
    poll, timers, listeners, data, errors, busy,
    visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; listeners.get('visibilitychange')?.(); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('polling coalesces refreshes, pauses hidden, resumes immediately, and cleans up', async () => {
  const requests = [];
  const f = fixture((url, options) => new Promise(resolve => requests.push({ url, options, resolve })));
  assert.equal(requests.length, 1);
  f.poll.refresh();
  f.poll.refresh();
  assert.equal(requests.length, 1, 'pending requests must not overlap');
  requests[0].resolve(Response.json({ calls: [], generatedAt: 1 }));
  await flush();
  assert.equal(f.data.length, 1);
  assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [10_000]);
  assert.equal(requests[0].url, 'api/auralis.usage');
  assert.equal(requests[0].options.cache, 'no-store');
  f.visible(false);
  assert.equal(f.timers.size, 0);
  f.poll.refresh();
  assert.equal(requests.length, 1);
  f.visible(true);
  assert.equal(requests.length, 2);
  f.poll.stop();
  assert.equal(requests[1].options.signal.aborted, true);
  requests[1].resolve(Response.json({ generatedAt: 2 }));
  await flush();
  assert.equal(f.data.length, 1, 'unmounted requests cannot publish stale data');
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('failed refresh reports an error without replacing the last good snapshot', async () => {
  let count = 0;
  const f = fixture(async () => ++count === 1 ? Response.json({ generatedAt: 1 }) : new Response('denied', { status: 401 }));
  await flush();
  await f.poll.refresh();
  assert.equal(f.data.length, 1);
  assert.match(f.errors.at(-1), /401/);
  assert.equal(f.busy.at(-1), false);
  assert.equal(f.timers.size, 1, 'a failed request still schedules a retry');
  f.poll.stop();
});

test('malformed JSON and network failures are visible and allow later retries', async () => {
  let attempt = 0;
  const f = fixture(async () => {
    attempt++;
    if (attempt === 1) return new Response('{', { headers: { 'content-type': 'application/json' } });
    if (attempt === 2) throw new Error('offline');
    return Response.json({ generatedAt: 3 });
  });
  await flush();
  assert.equal(f.data.length, 0);
  assert.equal(typeof f.errors.at(-1), 'string');
  await f.poll.refresh();
  assert.match(f.errors.at(-1), /offline/);
  await f.poll.refresh();
  assert.equal(f.data[0].generatedAt, 3);
  assert.equal(f.errors.at(-1), undefined);
  f.poll.stop();
});

test('hidden completion does not schedule background reads and resumes with a new snapshot', async () => {
  const requests = [];
  const f = fixture((url, options) => new Promise(resolve => requests.push({ url, options, resolve })));
  f.visible(false);
  requests[0].resolve(Response.json({ generatedAt: 1 }));
  await flush();
  assert.equal(f.timers.size, 0);
  f.visible(true);
  assert.equal(requests.length, 2);
  requests[1].resolve(Response.json({ generatedAt: 2 }));
  await flush();
  assert.deepEqual(f.data.map(value => value.generatedAt), [1, 2]);
  f.poll.stop();
});

test('initially hidden pages wait for visibility and fetch only once per interval', async () => {
  let calls = 0;
  let listener;
  let callback;
  const document = { visibilityState: 'hidden', addEventListener: (_, fn) => { listener = fn; }, removeEventListener() {} };
  const poll = startUsagePolling({
    document, interval: 60_000, fetcher: async () => { calls++; return Response.json({}); },
    setTimer: fn => { callback = fn; return 1; }, clearTimer() {}, onData() {}, onError() {}, onLoading() {},
  });
  assert.equal(calls, 0);
  document.visibilityState = 'visible';
  listener();
  await flush();
  assert.equal(calls, 1);
  callback();
  await flush();
  assert.equal(calls, 2);
  poll.stop();
});

test('late response from a previous polling instance cannot overwrite a new range snapshot', async () => {
  let resolveOld;
  const received = [];
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const options = { document, interval: 10_000, setTimer: () => 1, clearTimer() {}, onData: value => received.push(value), onError() {}, onLoading() {} };
  const old = startUsagePolling({ ...options, fetcher: () => new Promise(resolve => { resolveOld = resolve; }) });
  old.stop();
  const current = startUsagePolling({ ...options, fetcher: async () => Response.json({ generatedAt: 2 }) });
  await flush();
  resolveOld(Response.json({ generatedAt: 1 }));
  await flush();
  assert.deepEqual(received, [{ generatedAt: 2 }]);
  current.stop();
});

test('preferences validate stale values and report unavailable browser storage', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const allowed = ['15m', '30m', '1h', '24h'];
  assert.equal(readPreference(storage, 'range', '24h', allowed), '24h');
  assert.equal(savePreference(storage, 'range', '30m'), undefined);
  assert.equal(readPreference(storage, 'range', '24h', allowed), '30m');
  storage.setItem('range', 'obsolete');
  assert.equal(readPreference(storage, 'range', '24h', allowed), '24h');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  const warnings = [];
  assert.equal(readPreference(broken, 'range', '24h', allowed, message => warnings.push(message)), '24h');
  assert.match(warnings[0], /blocked/);
  assert.match(savePreference(broken, 'range', '1h'), /quota/);
});
