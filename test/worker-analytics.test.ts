import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSignedCookie } from "better-call";
import worker from "../src/worker";
import { issueKey } from "../src/access";
import type { AppEnv } from "../src/env";
import { anthropicFixture } from "./fixtures";

const appEnv: AppEnv = { ...env, BETTER_AUTH_URL: "http://localhost:8787", BETTER_AUTH_SECRET: "analytics-tests-secret-not-for-real-use-12345",
  HACKCLUB_CLIENT_ID: "test-client", HACKCLUB_CLIENT_SECRET: "test-secret", ALLOWED_HACKCLUB_IDS: "ident!analytics", RELAY_SHARED_SECRET: "test-relay-key",
  PROVIDERS_JSON: JSON.stringify([{ id: "claude", protocol: "anthropic", baseUrl: "https://relay.test/v1", credential: "RELAY_SHARED_SECRET", models: { claude: "upstream-claude" } }]),
};
let cookie: string, token: string;
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([env.DB.prepare('DELETE FROM "user"'), env.DB.prepare("DELETE FROM quota"), env.DB.prepare("DELETE FROM proxy_member")]);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind("analytics-user", "Test Friend", "private@example.com", now, now),
    env.DB.prepare('INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind("analytics-account", "ident!analytics", "hackclub", "analytics-user", now, now),
    env.DB.prepare('INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)').bind("analytics-session", now + 3_600_000, "analytics-session-token", now, now, "analytics-user"),
  ]);
  cookie = (await serializeSignedCookie("better-auth.session_token", "analytics-session-token", appEnv.BETTER_AUTH_SECRET)).split(";")[0]!;
  token = (await issueKey(appEnv, "analytics-user", "Test key")).key;
});
async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`http://localhost:8787${path}`, init), appEnv, ctx);
  return { response, ctx };
}
async function generate(stream = false, fixture = anthropicFixture(true)) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(fixture, { headers: { "content-type": "text/event-stream" } }));
  return call("/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude", input: "PRIVATE PROMPT", stream, tools: [{ type: "function", name: "read_file" }] }) });
}
async function metrics(days = 7) {
  const { response, ctx } = await call(`/api/analytics?days=${days}`, { headers: { cookie } });
  await waitOnExecutionContext(ctx); expect(response.status).toBe(200);
  return response.json<any>();
}

describe("Persistent usage analytics", () => {
  it.each([false, true])("tracks cumulative tokens and issued tools once (stream=%s)", async stream => {
    const { response, ctx } = await generate(stream);
    expect(response.status).toBe(200); await response.text(); await waitOnExecutionContext(ctx);
    const report = await metrics();
    expect(report.totals).toMatchObject({ requests: 1, successfulRequests: 1, failedRequests: 0, cancelledRequests: 0,
      inputTokens: 13, outputTokens: 7, cachedTokens: 3, totalTokens: 20, toolCalls: 1, activeMembers: 1, successRate: 100 });
    expect(report.leaderboard).toMatchObject([{ rank: 1, name: "Test Friend", isYou: true, activeDays: 1, totalTokens: 20 }]);
    expect(report.models).toMatchObject([{ model: "claude", requests: 1, totalTokens: 20 }]);
    expect(report.daily).toHaveLength(7);
    expect(report.daily.reduce((sum: number, row: any) => sum + row.requests, 0)).toBe(1);
    const rows = await env.DB.prepare("SELECT * FROM usage_event").all();
    expect(JSON.stringify(rows.results)).not.toContain("PRIVATE PROMPT");
    expect(JSON.stringify(rows.results)).not.toContain("README.md");
    expect(JSON.stringify(report)).not.toContain("private@example.com");
    expect(JSON.stringify(report)).not.toContain("analytics-user");
  });
  it("records upstream rejection as failure without retaining its body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("PRIVATE UPSTREAM FAILURE", { status: 429 }));
    const { response, ctx } = await call("/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: '{"model":"claude","input":"hello"}' });
    expect(response.status).toBe(429); await waitOnExecutionContext(ctx);
    const report = await metrics();
    expect(report.totals).toMatchObject({ requests: 1, failedRequests: 1, successfulRequests: 0, totalTokens: 0, successRate: 0 });
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM usage_event").all())).not.toContain("PRIVATE UPSTREAM");
  });
  it("marks a truncated stream failed despite its HTTP 200", async () => {
    const fixture = anthropicFixture().split("event: message_delta")[0]!;
    const { response, ctx } = await generate(true, fixture);
    expect(response.status).toBe(200); expect(await response.text()).toContain("response.failed"); await waitOnExecutionContext(ctx);
    expect((await metrics()).totals).toMatchObject({ requests: 1, failedRequests: 1, successfulRequests: 0, inputTokens: 13, outputTokens: 0 });
  });
  it("records output validation errors instead of a successful upstream finish", async () => {
    const { response, ctx } = await generate(true, anthropicFixture(true).replace('\\"README.md\\"}', '\\"README.md\\",}'));
    expect(await response.text()).toContain("response.failed"); await waitOnExecutionContext(ctx);
    expect((await metrics()).totals).toMatchObject({ failedRequests: 1, successfulRequests: 0 });
  });
  it("records cancellation before consuming provider events exactly once", async () => {
    const { response, ctx } = await generate(true);
    await response.body!.cancel(); await waitOnExecutionContext(ctx);
    expect((await metrics()).totals).toMatchObject({ requests: 1, cancelledRequests: 1, failedRequests: 0, successfulRequests: 0 });
  });
  it("retains partial usage on mid-stream cancellation", async () => {
    const { response, ctx } = await generate(true);
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    let output = "";
    while (!output.includes("response.output_item.added")) output += decoder.decode((await reader.read()).value);
    await reader.cancel(); await waitOnExecutionContext(ctx);
    expect((await metrics()).totals).toMatchObject({ requests: 1, cancelledRequests: 1, inputTokens: 13, toolCalls: 1 });
  });
  it("excludes authentication, validation, and local rate-limit rejections", async () => {
    expect((await call("/v1/responses", { method: "POST", body: '{}' })).response.status).toBe(401);
    const headers = { authorization: `Bearer ${token}` };
    expect((await call("/v1/responses", { method: "POST", headers, body: '{"model":"missing","input":"hello"}' })).response.status).toBe(400);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO quota VALUES (?, ?, 20, ?)").bind("minute:analytics-user", Math.floor(now / 60_000), now + 120_000).run();
    expect((await call("/v1/responses", { method: "POST", headers, body: '{"model":"claude","input":"hello"}' })).response.status).toBe(429);
    expect((await metrics()).totals.requests).toBe(0);
  });
  it("ignores legacy daily limits and counters", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO proxy_member VALUES (?, 'active', '', 1, ?, ?)").bind("ident!analytics", now, now),
      env.DB.prepare("INSERT INTO quota VALUES (?, ?, 999999, ?)").bind("day:analytics-user", Math.floor(now / 86_400_000), now + 86_400_000),
    ]);
    const { response, ctx } = await generate(); expect(response.status).toBe(200); await response.text(); await waitOnExecutionContext(ctx);
    const me = await call("/api/me", { headers: { cookie } });
    expect((await me.response.json<any>()).usage).toEqual({ requestsToday: 1, totalTokensToday: 20 });
  });
  it("requires active membership and validates date windows", async () => {
    expect((await call("/api/analytics")).response.status).toBe(401);
    expect((await call("/api/analytics?days=9000", { headers: { cookie } })).response.status).toBe(400);
    await env.DB.prepare("INSERT INTO proxy_member VALUES (?, 'suspended', '', NULL, ?, ?)").bind("ident!analytics", Date.now(), Date.now()).run();
    expect((await call("/api/analytics", { headers: { cookie } })).response.status).toBe(403);
  });
  it("filters UTC dates, zero-fills inactive days, and ranks members by tokens", async () => {
    const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    await env.DB.prepare('INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind("second", "Second Friend", "another-private@example.com", today, today).run();
    for (const [id, user, age, tokens] of [["a", "analytics-user", 0, 30], ["b", "analytics-user", 6, 10], ["c", "second", 0, 80], ["d", "second", 7, 100], ["e", "second", 30, 900]]) {
      await env.DB.prepare("INSERT INTO usage_event (id,user_id,model,provider,protocol,started_at,status,input_tokens,duration_ms) VALUES (?,?, 'claude', 'test', 'responses', ?, 'success', ?, 100)")
        .bind(id, user, today - Number(age) * 86_400_000, tokens).run();
    }
    const week = await metrics();
    expect(week.totals).toMatchObject({ requests: 3, totalTokens: 120, activeMembers: 2, avgDurationMs: 100 });
    expect(week.leaderboard).toMatchObject([{ name: "Second Friend", totalTokens: 80, rank: 1, isYou: false }, { name: "Test Friend", totalTokens: 40, activeDays: 2, isYou: true }]);
    expect(week.daily[0].requests).toBe(1); expect(week.daily[1].requests).toBe(0);
    const month = await metrics(30); expect(month.daily).toHaveLength(30); expect(month.totals).toMatchObject({ requests: 4, totalTokens: 220 });
  });
});
