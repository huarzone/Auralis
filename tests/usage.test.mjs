import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { USAGE_PATH, createUsageCollector, extractCalls, firstTokenTime, registerUsageRoute } from '../src/usage-server.mjs';
import * as server from '../src/index.mjs';

const require = createRequire(import.meta.url);
const { USAGE_ROUTE, analyze, rangeWindow, percentile, formatCount, formatMs, createUsageView } = require('../src/usage-view.cjs');

const finish = (time, kind, failure) => ({ type: 'chunk', time, chunk: { type: 'finish', reason: failure ? { kind, failure } : { kind } } });
const usage = (time, value) => ({ type: 'chunk', time, chunk: { type: 'usage', usage: value } });

// Shapes copied from a real session log: one successful step, then a rate-limited attempt and its retry.
function sampleEvents() {
  return [
    { type: 'model/selection', seq: 1, time: 900, data: { provider: 'openai', model: 'gpt-x' } },
    { type: 'step/start', seq: 2, time: 1000, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 3, time: 1001, data: { header: { config: { provider: 'openai', model: 'gpt-x', reasoningEffort: 'high' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 4, time: 4700, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-x' } },
      usage: { inputTokens: 3, outputTokens: 11, totalTokens: 6051, cacheWriteTokens: 6037 },
      stream: [
        { type: 'chunk', time: 3300, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: 3335, index: 0, dt: [10, 1], texts: ['', '你好', '！'] },
        usage(4690, { inputTokens: 3, outputTokens: 11, totalTokens: 6051, cacheWriteTokens: 6037 }),
        finish(4690, 'stop'),
      ],
    } },
    { type: 'step/start', seq: 5, time: 5000, data: { turn: 1, step: 2 } },
    { type: 'assistant/attempt', seq: 6, time: 5600, data: { turn: 1, step: 2, stream: [
      usage(5599, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      finish(5600, 'error', { message: 'Rate limit reached', code: 'RATE_LIMIT' }),
    ] } },
    { type: 'llm/retry', seq: 7, time: 5601, data: { turn: 1, step: 2, retry: 1 } },
    { type: 'llm/retry-started', seq: 8, time: 6100, data: { turn: 1, step: 2, retry: 1 } },
    { type: 'assistant/message', seq: 9, time: 9100, data: {
      turn: 1, step: 2,
      message: { role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-x' } },
      usage: { inputTokens: 20, outputTokens: 40, cacheReadTokens: 6000, reasoningTokens: 12 },
      stream: [{ type: 'tool-call-chunks', time0: 7100, index: 0, dt: [], id: 't', name: 'bash', args: ['{}'] }, finish(9090, 'tool-calls')],
    } },
  ];
}

test('firstTokenTime matches dsh-llm: first non-empty delta, or a named tool call', () => {
  assert.equal(firstTokenTime([{ type: 'text-chunks', time0: 10, dt: [5, 5], texts: ['', '', 'a'] }]), 20);
  assert.equal(firstTokenTime([{ type: 'tool-call-chunks', time0: 7, dt: [], name: 'x', args: [] }]), 7);
  assert.equal(firstTokenTime([{ type: 'chunk', time: 3, chunk: { type: 'usage' } }]), undefined);
});

test('extractCalls turns messages and failed attempts into call rows with tokens, TTFT and latency', () => {
  const calls = extractCalls('s1', sampleEvents());
  assert.equal(calls.length, 3);
  const [first, failed, retried] = calls;
  assert.deepEqual(
    { model: first.model, effort: first.effort, input: first.input, output: first.output, cacheWrite: first.cacheWrite, total: first.total, ttft: first.ttft, duration: first.duration, ok: first.ok },
    { model: 'gpt-x', effort: 'high', input: 3, output: 11, cacheWrite: 6037, total: 6051, ttft: 2345, duration: 3690, ok: true },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'RATE_LIMIT');
  assert.equal(failed.duration, 600);
  assert.equal(failed.ttft, undefined);
  // The retry is timed from llm/retry-started, not from the original step start.
  assert.equal(retried.ttft, 1000);
  assert.equal(retried.duration, 2990);
  assert.equal(retried.finish, 'tool-calls');
  assert.equal(retried.total, 6060, 'missing totalTokens falls back to the disjoint bucket sum');
  assert.equal(retried.reasoning, 12);
});

test('fork-inherited events restore routing but are not counted twice', () => {
  const events = sampleEvents();
  assert.equal(extractCalls('fork', events, 4).length, 2);
  assert.equal(extractCalls('fork', events, 4)[0].model, 'gpt-x');
});

test('interrupted messages are reported as aborted, not successful', () => {
  const events = sampleEvents();
  events[3] = { ...events[3], data: { ...events[3].data, interrupted: true } };
  const [first] = extractCalls('s', events);
  assert.equal(first.finish, 'aborted');
  assert.equal(first.ok, false);
});

function fakeQuery(overrides = {}) {
  const reads = [];
  return {
    reads,
    async listSessions() {
      return [
        { header: { id: 'done', cwd: '/w', createdAt: 1, origin: 'subagent', parentSession: 'live' }, live: false, persisted: true },
        { header: { id: 'live', cwd: '/w', createdAt: 2 }, live: true, persisted: true },
        { header: { id: 'broken', createdAt: 3 }, live: false, persisted: true },
        { header: { id: 'old', createdAt: 4 }, live: false, persisted: true, formatStatus: 'migration-required' },
      ];
    },
    async readSession(id) {
      reads.push(id);
      if (id === 'broken') throw new Error('corrupt log');
      return { session: {}, inheritedEventCount: 0, events: sampleEvents() };
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => (id === 'live'
        ? { sessionId: id, status: 'fulfilled', value: { session: {}, title: { title: '主会话' } } }
        : { sessionId: id, status: 'rejected', reason: new Error('x') }));
    },
    ...overrides,
  };
}

test('collector reads every session once, re-reads only live ones, and isolates unreadable logs', async () => {
  const query = fakeQuery();
  const collect = createUsageCollector(query);
  const first = await collect();
  assert.equal(first.calls.length, 6);
  assert.deepEqual(first.sessions.map(s => [s.id, s.subagent, s.title]), [['done', true, undefined], ['live', false, '主会话']]);
  assert.deepEqual(first.skipped.map(s => s.id), ['broken', 'old']);
  assert.match(first.skipped[0].reason, /corrupt log/);
  await collect();
  assert.deepEqual(query.reads, ['done', 'live', 'broken', 'live', 'broken']);
  assert.ok(first.calls.every((call, index, all) => index === 0 || all[index - 1].time <= call.time));
});

test('server registers authenticated owner-only routes through Connection', async t => {
  assert.deepEqual(server.inject, ['connection', 'sessionQuery', 'profileContext']);
  const dir = await mkdtemp(join(tmpdir(), 'auralis-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const routes = [];
  server.apply({
    connection: { fetch: { register: route => routes.push(route) } }, sessionQuery: fakeQuery(),
    profileContext: { dir }, get: () => undefined,
  });
  assert.deepEqual(routes.map(route => route.path), [USAGE_PATH, '/api/auralis.settings', '/api/auralis.background', '/api/auralis.host']);
  assert.ok(routes.every(route => !Object.hasOwn(route, 'auth')), 'Connection default authentication is preserved');
  assert.ok(routes.slice(1).every(route => route.methods.join() === 'GET,POST' && route.requestBody === 'buffered'));
  assert.match(USAGE_PATH.slice(5), /^[A-Za-z0-9_$.-]+$/);
  assert.equal(USAGE_ROUTE, USAGE_PATH.slice(1), 'browser fetches the document-relative form');
  assert.deepEqual(routes[0].methods, ['GET']);
  const response = await routes[0].fetch(new Request('http://x/api/auralis.usage'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).calls.length, 6);
  assert.equal(typeof registerUsageRoute, 'function');
});

test('range windows bucket today and yesterday on local midnight', () => {
  const now = new Date(2026, 10, 5, 13, 30).getTime();
  const today = rangeWindow('today', now);
  assert.equal(today.start, new Date(2026, 10, 5).getTime());
  assert.equal(today.step, 3_600_000);
  const yesterday = rangeWindow('yesterday', now);
  assert.equal(yesterday.end, today.start);
  assert.equal(yesterday.start, new Date(2026, 10, 4).getTime());
  const all = rangeWindow('all', now, now - 10 * 86_400_000);
  assert.ok((all.end - all.start) / all.step <= 48);
});

test('analyze folds calls into KPIs, stacked buckets, model and error distributions', () => {
  const calls = extractCalls('s1', sampleEvents()).map(call => ({ ...call, time: call.time + 60_000 }));
  const stats = analyze(calls, { start: 0, end: 600_000, step: 60_000 });
  assert.equal(stats.kpi.calls, 3);
  assert.equal(stats.kpi.failed, 1);
  assert.equal(stats.kpi.total, 12_111);
  assert.equal(stats.kpi.reasoning, 12);
  assert.equal(stats.kpi.rpm, 0.3);
  assert.equal(stats.kpi.cacheRate, 6000 / (23 + 6000 + 6037));
  assert.equal(stats.series.length, 10);
  assert.equal(stats.series[1].calls, 3);
  assert.equal(stats.series[1].input + stats.series[1].cacheRead + stats.series[1].cacheWrite + stats.series[1].output, 12_111);
  assert.deepEqual(stats.errors.map(error => [error.code, error.count]), [['RATE_LIMIT', 1]]);
  assert.equal(stats.models.length, 1);
  assert.equal(stats.models[0].ttft.count, 2, 'failed calls do not skew latency');
  assert.equal(stats.ttft.p50, 1000);
  assert.equal(stats.histogram.reduce((sum, bin) => sum + bin.duration, 0), 2);
  assert.equal(analyze(calls, { start: 0, end: 60_000, step: 60_000 }).kpi.calls, 0);
});

test('number helpers', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([], 0.5), undefined);
  assert.equal(formatCount(9999), '9,999');
  assert.equal(formatCount(11_438_205), '11.4M');
  assert.equal(formatMs(850), '850 ms');
  assert.equal(formatMs(2506), '2.51 s');
  assert.equal(formatMs(undefined), '—');
});

function fakeReact() {
  let id = 0;
  return {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat() }; },
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useMemo: fn => fn(), useCallback: fn => fn, useEffect() {},
    useRef: value => ({ current: value }), useId: () => `usage-test-${++id}`,
  };
}
function render(node) {
  if (Array.isArray(node)) return node.map(render);
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }));
  return { ...node, children: node.children.map(render) };
}

test('dashboard pieces render handwritten SVG without remote assets', () => {
  const view = createUsageView(fakeReact());
  const calls = extractCalls('s1', sampleEvents());
  const stats = analyze(calls, { start: 0, end: 600_000, step: 60_000 });
  const bars = JSON.stringify(render(view.TokenBars({ series: stats.series, step: 60_000, kpi: stats.kpi })));
  for (const color of ['#3b82f6', '#14b8a6', '#8b5cf6', '#f97316']) assert.ok(bars.includes(color));
  assert.match(bars, /"type":"svg"/);
  const icon = view.UsageIcon({ size: 18 });
  assert.equal(icon.props.width, 18);
  assert.equal(icon.props.stroke, 'currentColor');
  const page = JSON.stringify(render(view.UsagePage()));
  assert.match(page, /使用分析/);
  assert.match(page, /正在汇总/);
  assert.doesNotMatch(page, /https?:\/\//);
});
