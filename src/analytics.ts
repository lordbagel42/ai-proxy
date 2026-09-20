import { ApiError } from "./core/errors";
import type { Event, Protocol } from "./core/types";
import type { AppEnv } from "./env";

const DAY = 86_400_000;
type Outcome = "success" | "error" | "cancelled";
const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** One metadata row per accepted generation; no request/response content is retained. */
export class GenerationUsage {
  private readonly id = crypto.randomUUID();
  private readonly startedAt = Date.now();
  private readonly inserted: Promise<unknown>;
  private finished = false;
  private input = 0;
  private output = 0;
  private cached = 0;
  private tools = new Set<number>();
  private readonly abort = () => this.finish(this.signal.reason instanceof DOMException && this.signal.reason.name === "TimeoutError" ? "error" : "cancelled");

  constructor(private env: AppEnv, private ctx: ExecutionContext, userId: string, model: string, provider: string,
    protocol: Protocol, private signal: AbortSignal) {
    this.inserted = env.DB.prepare(`INSERT INTO usage_event (id, user_id, model, provider, protocol, started_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(this.id, userId, model, provider, protocol, this.startedAt).run();
    ctx.waitUntil(this.inserted.catch(() => { console.error("Usage tracking insert failed."); }));
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  async *observe(events: AsyncIterable<Event>): AsyncGenerator<Event> {
    for await (const event of events) {
      if (event.type === "usage") {
        // Provider usage events are cumulative snapshots, never deltas.
        this.input = count(event.input); this.output = count(event.output);
        this.cached = Math.min(this.input, count(event.cached ?? 0));
      } else if (event.type === "tool_start") this.tools.add(event.index);
      yield event;
    }
  }

  finish(status: Outcome): void {
    if (this.finished) return;
    this.finished = true;
    this.signal.removeEventListener("abort", this.abort);
    const duration = Math.max(0, Date.now() - this.startedAt);
    const input = this.input, output = this.output, cached = this.cached, tools = this.tools.size;
    this.ctx.waitUntil(this.inserted.then(() => this.env.DB.prepare(`UPDATE usage_event SET status = ?, duration_ms = ?,
      input_tokens = ?, output_tokens = ?, cached_tokens = ?, tool_calls = ? WHERE id = ? AND status = 'running'`)
      .bind(status, duration, input, output, cached, tools, this.id).run()).catch(() => { console.error("Usage tracking update failed."); }));
  }
}

export async function personalUsage(env: AppEnv, userId: string) {
  return await env.DB.prepare(`SELECT count(*) AS requestsToday, COALESCE(sum(input_tokens + output_tokens), 0) AS totalTokensToday
    FROM usage_event WHERE user_id = ? AND started_at >= ?`).bind(userId, Math.floor(Date.now() / DAY) * DAY)
    .first<{ requestsToday: number; totalTokensToday: number }>();
}

const aggregates = `count(*) AS requests, COALESCE(sum(input_tokens), 0) AS inputTokens,
  COALESCE(sum(output_tokens), 0) AS outputTokens, COALESCE(sum(input_tokens + output_tokens), 0) AS totalTokens,
  COALESCE(sum(tool_calls), 0) AS toolCalls`;
interface Metrics { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; toolCalls: number }
interface Totals extends Metrics {
  cachedTokens: number; successfulRequests: number; failedRequests: number; cancelledRequests: number;
  runningRequests: number; activeMembers: number; avgDurationMs: number;
}
interface Daily extends Metrics { date: string; activeMembers: number }
interface Leader extends Metrics { userId: string; name: string; activeDays: number; lastActiveAt: number }
interface Model extends Metrics { model: string }

export async function getAnalytics(env: AppEnv, userId: string, requestedDays: string | null) {
  if (requestedDays !== null && requestedDays !== "7" && requestedDays !== "30") throw new ApiError(400, "Choose a 7 or 30 day analytics window.");
  const days = Number(requestedDays ?? "7");
  const to = Date.now(), from = Math.floor(to / DAY) * DAY - (days - 1) * DAY;
  // One read transaction gives cards, chart, and leaderboard the same snapshot.
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT ${aggregates}, COALESCE(sum(cached_tokens), 0) AS cachedTokens,
      COALESCE(sum(status = 'success'), 0) AS successfulRequests, COALESCE(sum(status = 'error'), 0) AS failedRequests,
      COALESCE(sum(status = 'cancelled'), 0) AS cancelledRequests, COALESCE(sum(status = 'running'), 0) AS runningRequests,
      count(DISTINCT user_id) AS activeMembers, COALESCE(round(avg(CASE WHEN status <> 'running' THEN duration_ms END)), 0) AS avgDurationMs
      FROM usage_event WHERE started_at >= ? AND started_at <= ?`).bind(from, to),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS date, ${aggregates},
      count(DISTINCT user_id) AS activeMembers FROM usage_event WHERE started_at >= ? AND started_at <= ? GROUP BY date ORDER BY date`).bind(from, to),
    env.DB.prepare(`SELECT e.user_id AS userId, u.name, count(*) AS requests, sum(e.input_tokens) AS inputTokens,
      sum(e.output_tokens) AS outputTokens, sum(e.input_tokens + e.output_tokens) AS totalTokens, sum(e.tool_calls) AS toolCalls,
      count(DISTINCT CAST(e.started_at / ${DAY} AS INTEGER)) AS activeDays, max(e.started_at) AS lastActiveAt
      FROM usage_event e JOIN "user" u ON u.id = e.user_id WHERE e.started_at >= ? AND e.started_at <= ?
      GROUP BY e.user_id ORDER BY totalTokens DESC, requests DESC, u.name COLLATE NOCASE, e.user_id LIMIT 50`).bind(from, to),
    env.DB.prepare(`SELECT model, ${aggregates} FROM usage_event WHERE started_at >= ? AND started_at <= ?
      GROUP BY model ORDER BY requests DESC, model LIMIT 100`).bind(from, to),
  ]);
  const totals = results[0]!.results[0] as unknown as Totals;
  const daily = new Map((results[1]!.results as unknown as Daily[]).map(row => [row.date, row]));
  const settled = totals.successfulRequests + totals.failedRequests + totals.cancelledRequests;
  return {
    days, from, to,
    totals: { ...totals, successRate: settled ? Math.round(totals.successfulRequests / settled * 1000) / 10 : 0 },
    daily: Array.from({ length: days }, (_, i) => {
      const date = new Date(from + i * DAY).toISOString().slice(0, 10);
      return daily.get(date) ?? { date, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, activeMembers: 0 };
    }),
    leaderboard: (results[2]!.results as unknown as Leader[]).map(({ userId: id, ...row }, i) => ({ ...row, rank: i + 1, isYou: id === userId })),
    models: results[3]!.results as unknown as Model[],
  };
}
