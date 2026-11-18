/**
 * Auralis 使用分析的服务端：从会话日志提取每次模型调用，经 Connection 鉴权路由提供给浏览器。
 * 核心：extractCalls（纯函数，事件 → 调用行）、createUsageCollector（带缓存的全量汇集）、registerUsageRoute。
 */

/** 浏览器相对路径为 `api/auralis.usage`；位于 Connection 鉴权围栏内，仅 owner 可读。 */
export const USAGE_PATH = '/api/auralis.usage';

const OK_FINISH = new Set(['stop', 'tool-calls', 'max-tokens']);
const DELTA_CHUNKS = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta']);

/** 与 dsh-llm 的 assistantStreamFirstTokenTime 同义：首个非空增量的时间。 */
export function firstTokenTime(stream) {
  for (const record of stream) {
    if (record.type === 'chunk') {
      if (DELTA_CHUNKS.has(record.chunk?.type)) return record.time;
      continue;
    }
    if (record.type === 'tool-call-chunks' && record.name !== undefined) return record.time0;
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts;
    let time = record.time0;
    for (let index = 0; index < (members?.length ?? 0); index++) {
      if (index > 0) time += record.dt[index - 1];
      if (members[index] !== '') return time;
    }
  }
  return undefined;
}

function lastChunk(stream, type) {
  for (let index = stream.length - 1; index >= 0; index--) {
    const record = stream[index];
    if (record.type === 'chunk' && record.chunk?.type === type) return record;
  }
  return undefined;
}

/**
 * 把一个会话的事件折叠为模型调用行；`assistant/attempt` 是失败或被重试的调用，同样计数。
 * @param sessionId - 会话 id。
 * @param events - readSession 返回的完整事件。
 * @param inherited - fork 继承的事件数；这些事件只用于恢复模型路由，不重复计数。
 */
export function extractCalls(sessionId, events, inherited = 0) {
  const calls = [];
  const starts = new Map();
  let route = {};
  events.forEach((event, index) => {
    const data = event.data ?? {};
    const key = `${data.turn}.${data.step}`;
    switch (event.type) {
      case 'model/selection':
        route = { provider: data.provider, model: data.model, effort: data.reasoningEffort };
        return;
      case 'request/header': {
        const config = data.header?.config;
        if (config) route = { provider: config.provider, model: config.model, effort: config.reasoningEffort };
        return;
      }
      case 'step/start':
      case 'llm/retry-started':
        starts.set(key, event.time);
        return;
      case 'assistant/message':
      case 'assistant/attempt':
        break;
      default:
        return;
    }
    const stream = data.stream ?? [];
    const start = starts.get(key);
    starts.set(key, event.time);
    if (index < inherited) return;
    const usage = data.usage ?? lastChunk(stream, 'usage')?.chunk.usage ?? {};
    const finishRecord = lastChunk(stream, 'finish');
    const reason = finishRecord?.chunk.reason;
    const source = data.message?.source?.kind === 'model' ? data.message.source : undefined;
    const first = firstTokenTime(stream);
    const end = finishRecord?.time ?? event.time;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    const finish = data.interrupted ? 'aborted' : reason?.kind ?? (event.type === 'assistant/attempt' ? 'error' : 'stop');
    calls.push({
      time: event.time,
      session: sessionId,
      turn: data.turn,
      step: data.step,
      provider: source?.provider ?? route.provider ?? 'unknown',
      model: source?.model ?? route.model ?? 'unknown',
      effort: route.effort,
      input, output, cacheRead, cacheWrite,
      reasoning: usage.reasoningTokens ?? 0,
      total: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
      ttft: start !== undefined && first !== undefined ? Math.max(0, first - start) : undefined,
      duration: start !== undefined ? Math.max(0, end - start) : undefined,
      finish,
      ok: event.type === 'assistant/message' && OK_FINISH.has(finish),
      code: reason?.failure?.code,
      error: reason?.failure?.message?.slice(0, 240),
    });
  });
  return calls;
}

/**
 * 汇集全部会话的调用行。已结束（非 live）的会话日志不再变化，按 id 缓存；live 会话每次重读。
 * 单个会话读取失败（外部 I/O）不拖垮整页，计入 `skipped` 并返回原因。
 */
export function createUsageCollector(sessionQuery) {
  const cache = new Map();
  return async function collect(signal) {
    const records = await sessionQuery.listSessions(signal);
    const sessions = [];
    const calls = [];
    const skipped = [];
    for (const record of records) {
      const { header } = record;
      if (record.formatStatus === 'migration-required') {
        skipped.push({ id: header.id, reason: 'migration-required' });
        continue;
      }
      let rows = record.live ? undefined : cache.get(header.id);
      if (!rows) {
        try {
          const snapshot = await sessionQuery.readSession(header.id);
          rows = extractCalls(header.id, snapshot.events, snapshot.inheritedEventCount);
        } catch (error) {
          skipped.push({ id: header.id, reason: String(error?.message ?? error).slice(0, 200) });
          continue;
        }
        if (!record.live) cache.set(header.id, rows);
      }
      sessions.push({
        id: header.id, cwd: header.cwd, createdAt: header.createdAt, parent: header.parentSession,
        subagent: header.origin === 'subagent', live: record.live,
      });
      calls.push(...rows);
    }
    const titles = await sessionQuery.readTitleSnapshots(sessions.map(session => session.id), signal);
    const byId = new Map(titles.filter(result => result.status === 'fulfilled').map(result => [result.sessionId, result.value.title?.title]));
    for (const session of sessions) session.title = byId.get(session.id);
    calls.sort((a, b) => a.time - b.time);
    return { generatedAt: Date.now(), sessions, calls, skipped };
  };
}

/** 注册鉴权 GET 路由；不要用 webServer.register，那条路径没有鉴权。 */
export function registerUsageRoute(ctx) {
  const collect = createUsageCollector(ctx.sessionQuery);
  ctx.connection.fetch.register({
    path: USAGE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => Response.json(await collect(request.signal), { headers: { 'cache-control': 'no-store' } }),
  });
}
