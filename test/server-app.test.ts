import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSignedCookie } from "better-call";
import worker from "../src/worker";
import { issueKey } from "../src/access";
import { seal } from "../src/codex/vault";
import type { AppEnv } from "../src/env";
import { createDatabase, migrateDatabase } from "../server/sqlite";
import { anthropicFixture } from "./fixtures";

type Role = "owner" | "friend" | "newcomer";
let database: ReturnType<typeof createDatabase>;
let env: AppEnv;
let friendKey: string;
const cookies = {} as Record<Role, string>;
let background: Promise<unknown>[];

async function settle() {
  // Streams can register accounting and lease cleanup after fetch() resolves.
  while (background.length) await Promise.all(background.splice(0));
}

async function call(path: string, init: RequestInit = {}) {
  const ctx = { waitUntil(promise: Promise<unknown>) { background.push(promise); }, passThroughOnException() {} } as ExecutionContext;
  return worker.fetch(new Request(`${env.BETTER_AUTH_URL}${path}`, init), env, ctx);
}

const browser = (role: Role = "owner") => ({ cookie: cookies[role], origin: env.BETTER_AUTH_URL, "content-type": "application/json" });
const api = (key = friendKey) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
const json = (body: unknown, role: Role = "owner", method = "POST") => ({ method, headers: browser(role), body: JSON.stringify(body) });

beforeEach(async () => {
  background = [];
  database = createDatabase(":memory:");
  await migrateDatabase(database, "migrations");
  env = {
    DB: database.asD1Database(),
    ASSETS: { fetch: async () => new Response("asset not found", { status: 404 }) } as unknown as Fetcher,
    BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "node-integration-test-secret-not-for-production",
    HACKCLUB_CLIENT_ID: "node-test-client", HACKCLUB_CLIENT_SECRET: "node-test-secret",
    ALLOWED_HACKCLUB_IDS: "ident!owner,ident!friend", OWNER_HACKCLUB_ID: "ident!owner", REQUESTS_PER_MINUTE: "20",
    RELAY_SHARED_SECRET: "node-test-provider-secret", CODEX_TOKEN_KEY: Buffer.alloc(32, 9).toString("base64url"),
    PROVIDERS_JSON: JSON.stringify([{ id: "claude", protocol: "anthropic", baseUrl: "https://relay.test/v1",
      credential: "RELAY_SHARED_SECRET", models: { claude: "upstream-claude" } }]),
  };
  const now = Date.now();
  for (const role of ["owner", "friend", "newcomer"] as const) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(`user-${role}`, `Test ${role}`, `${role}@example.test`, now, now),
      env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, 'hackclub', ?, ?, ?)")
        .bind(`account-${role}`, `ident!${role}`, `user-${role}`, now, now),
      env.DB.prepare("INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(`session-${role}`, now + 3_600_000, `node-session-${role}`, now, now, `user-${role}`),
    ]);
    cookies[role] = (await serializeSignedCookie("better-auth.session_token", `node-session-${role}`, env.BETTER_AUTH_SECRET)).split(";")[0]!;
  }
  friendKey = (await issueKey(env, "user-friend", "Node integration CLI")).key;
});

afterEach(async () => {
  try { await settle(); }
  finally { vi.restoreAllMocks(); database?.close(); }
});

describe("Application with Node SQLite", () => {
  it("rolls back a reusable invite's use count when creating membership fails", async () => {
    const created = await call("/api/admin/invites", json({ label: "Reusable Node invite", maxUses: 3 }));
    expect(created.status).toBe(201);
    const { invite, url } = await created.json<{ invite: { id: string }; url: string }>();
    const token = new URL(url).hash.slice(1);
    database.sqlite.exec("CREATE TRIGGER fail_join BEFORE INSERT ON proxy_member BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    expect((await call("/api/invites/accept", json({ token }, "newcomer"))).status).toBe(500);
    expect(await env.DB.prepare("SELECT use_count FROM proxy_invite WHERE id = ?").bind(invite.id).first()).toEqual({ use_count: 0 });
    database.sqlite.exec("DROP TRIGGER fail_join");
    expect((await call("/api/invites/accept", json({ token }, "newcomer"))).status).toBe(200);
    expect((await call("/api/invites/accept", json({ token }, "newcomer"))).status).toBe(200);
    expect(await env.DB.prepare("SELECT use_count FROM proxy_invite WHERE id = ?").bind(invite.id).first()).toEqual({ use_count: 1 });
  });

  it("reads Better Auth sessions and owner permissions through the real Drizzle adapter", async () => {
    expect((await call("/api/session")).status).toBe(401);
    const owner = await call("/api/session", { headers: browser() });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ user: { name: "Test owner" }, isOwner: true, hasAccess: true });
    const pending = await call("/api/session", { headers: browser("newcomer") });
    expect(await pending.json()).toMatchObject({ isOwner: false, hasAccess: false });
    expect((await call("/api/admin/overview", { headers: browser("friend") })).status).toBe(403);
    const admin = await call("/api/admin/overview", { headers: browser() });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ summary: { activeMembers: 2, activeKeys: 1 } });
  });

  it("creates encrypted OAuth account tokens and a usable session during Hack Club login", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://auth.hackclub.com/oauth/token") {
        return Response.json({ access_token: "test-hackclub-private-token", token_type: "Bearer", expires_in: 600, scope: "email name" });
      }
      if (url === "https://auth.hackclub.com/api/v1/me") {
        return Response.json({ identity: { id: "ident!oauth", primary_email: "oauth@example.test", first_name: "OAuth", last_name: "Friend" } });
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const start = await call("/api/auth/sign-in/social", json({ provider: "hackclub", callbackURL: "/" }));
    expect(start.status).toBe(200);
    const destination = new URL((await start.json<{ url: string }>()).url);
    expect(destination.searchParams.get("code_challenge_method")).toBe("S256");
    expect(destination.searchParams.get("redirect_uri")).toBe(`${env.BETTER_AUTH_URL}/api/auth/callback/hackclub`);
    const stateCookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const callback = await call(`/api/auth/callback/hackclub?code=node-test-code&state=${encodeURIComponent(destination.searchParams.get("state")!)}`,
      { headers: { cookie: stateCookie } });
    expect(callback.status).toBe(302);
    const sessionCookie = callback.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const profile = await call("/api/session", { headers: { cookie: sessionCookie } });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ user: { email: "oauth@example.test" }, hasAccess: false });
    const account = await env.DB.prepare("SELECT access_token FROM account WHERE account_id = 'ident!oauth'").first<{ access_token: string }>();
    expect(account?.access_token).toBeTruthy();
    expect(account?.access_token).not.toContain("test-hackclub-private-token");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("redeems an invitation, approves a one-use CLI login, and immediately enforces suspension", async () => {
    expect((await call("/api/keys", json({ name: "Too early" }, "newcomer"))).status).toBe(403);
    const invitation = await call("/api/admin/invites", json({ label: "Node integration invite", targetIdentity: "ident!newcomer" }));
    expect(invitation.status).toBe(201);
    const invite = await invitation.json<{ url: string }>();
    const acceptance = () => call("/api/invites/accept", json({ token: new URL(invite.url).hash.slice(1) }, "newcomer"));
    expect((await acceptance()).status).toBe(200);
    expect((await acceptance()).status).toBe(200); // Retrying does not consume another use.
    const start = await call("/api/cli/start", { method: "POST", headers: { "cf-connecting-ip": "192.0.2.10" } });
    const pending = await start.json<{ device_code: string; user_code: string }>();
    const poll = () => call("/api/cli/poll", { method: "POST", body: JSON.stringify({ device_code: pending.device_code }) });
    expect((await poll()).status).toBe(202);
    const approve = () => call("/api/cli/approve", json({ user_code: pending.user_code }, "newcomer"));
    expect((await approve()).status).toBe(200);
    expect((await approve()).status).toBe(400);
    const approved = await poll();
    expect(approved.status).toBe(200);
    const { key } = await approved.json<{ key: string }>();
    expect((await poll()).status).toBe(400);
    expect((await call("/v1/models", { headers: api(key) })).status).toBe(200);
    expect((await call("/api/admin/members/ident!newcomer", json({ status: "suspended" }, "owner", "PATCH"))).status).toBe(204);
    expect((await call("/v1/models", { headers: api(key) })).status).toBe(403);
    expect((await call("/api/me", { headers: browser("newcomer") })).status).toBe(403);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM api_key WHERE user_id = 'user-newcomer'").first()).toEqual({ count: 1 });
  });

  it.each([
    ["messages", false], ["messages", true], ["chat/completions", false], ["chat/completions", true],
    ["responses", false], ["responses", true],
  ] as const)("records generation and leaderboard metrics for %s (stream=%s)", async (endpoint, stream) => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(anthropicFixture(),
      { headers: { "content-type": "text/event-stream" } }));
    const content = endpoint === "responses" ? { input: "PRIVATE NODE TEST PROMPT" }
      : { messages: [{ role: "user", content: "PRIVATE NODE TEST PROMPT" }], max_tokens: 100 };
    const response = await call(`/v1/${endpoint}`, { method: "POST", headers: api(), body: JSON.stringify({ model: "claude", stream, ...content }) });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("friend");
    if (stream) expect(response.headers.get("content-type")).toContain("text/event-stream");
    else expect(JSON.parse(body)).toHaveProperty("id");
    await settle();
    const metrics = await call("/api/analytics?days=7", { headers: browser("friend") });
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      totals: { requests: 1, successfulRequests: 1, failedRequests: 0, inputTokens: 13, outputTokens: 7, cachedTokens: 3, totalTokens: 20 },
      leaderboard: [{ rank: 1, name: "Test friend", isYou: true, totalTokens: 20 }],
    });
    const rows = await env.DB.prepare("SELECT * FROM usage_event").all();
    expect(rows.results).toHaveLength(1);
    expect(JSON.stringify(rows.results)).not.toContain("PRIVATE NODE TEST PROMPT");
    expect(await env.DB.prepare("SELECT last_used_at FROM api_key WHERE user_id = 'user-friend'").first("last_used_at")).toEqual(expect.any(Number));
    const sent = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(sent.get("authorization")).toBe("Bearer node-test-provider-secret");
  });

  it("finalizes streamed cancellations and failures once after the response is consumed", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const generate = () => call("/v1/responses", { method: "POST", headers: api(), body: JSON.stringify({ model: "claude", input: "hello", stream: true }) });
    upstream.mockResolvedValueOnce(new Response(anthropicFixture(), { headers: { "content-type": "text/event-stream" } }));
    const cancelled = await generate();
    expect(cancelled.status).toBe(200);
    await cancelled.body!.cancel();
    await settle();
    upstream.mockResolvedValueOnce(new Response(anthropicFixture().split("event: message_delta")[0],
      { headers: { "content-type": "text/event-stream" } }));
    const truncated = await generate();
    expect(await truncated.text()).toContain("response.failed");
    await settle();
    const metrics = await call("/api/analytics", { headers: browser("friend") });
    expect(await metrics.json()).toMatchObject({ totals: { requests: 2, cancelledRequests: 1, failedRequests: 1, successfulRequests: 0, runningRequests: 0 } });
  });

  it("uses the same encrypted account and persisted discovered catalog for the browser and CLI", async () => {
    env.PROVIDERS_JSON = JSON.stringify([{ id: "codex", protocol: "codex", discoverModels: true, models: {} }]);
    const now = Date.now();
    const encrypted = await seal(env, "tokens", { accessToken: "node-private-access", refreshToken: "node-private-refresh",
      accountId: "node-private-account", expiresAt: now + 3_600_000 });
    await env.DB.prepare("INSERT INTO codex_connection (id, owner_identity, credentials, expires_at, updated_at) VALUES ('codex', ?, ?, ?, ?)")
      .bind(env.OWNER_HACKCLUB_ID, encrypted, now + 3_600_000, now).run();
    const model = (slug: string, priority: number) => ({ slug, display_name: slug, default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }], shell_type: "unified_exec", visibility: "list",
      supported_in_api: false, priority, support_verbosity: false, truncation_policy: { mode: "tokens", limit: 10_000 },
      context_window: 272_000, experimental_supported_tools: [] });
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ models: [model("secondary", 2), model("preferred", 1)] }));
    const native = await call("/v1/models", { headers: api() });
    expect(native.status).toBe(200);
    const catalog = await native.json();
    expect(catalog).toMatchObject({ default_model: "preferred", data: [{ id: "preferred" }, { id: "secondary" }],
      models: [{ slug: "preferred", supported_in_api: true }, { slug: "secondary", supported_in_api: true }] });
    expect(await (await call("/api/models", { headers: browser("friend") })).json()).toEqual(catalog);
    const dashboard = await call("/api/me", { headers: browser("friend") });
    expect(await dashboard.json()).toMatchObject({ defaultModel: "preferred", modelCatalogStatus: "ready" });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.154.0");
    expect(new Headers(upstream.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer node-private-access");
    expect(JSON.stringify(catalog)).not.toMatch(/node-private/);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM codex_model_cache").first()).toEqual({ count: 1 });
  });
});
