import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSignedCookie } from "better-call";
import worker from "../src/worker";
import { digest, issueKey, takeRateLimit } from "../src/access";
import type { AppEnv } from "../src/env";
import { anthropicFixture } from "./fixtures";

const appEnv: AppEnv = { ...env, BETTER_AUTH_URL: "http://localhost:8787", BETTER_AUTH_SECRET: "worker-tests-secret-not-for-real-use-12345",
  HACKCLUB_CLIENT_ID: "test-client", HACKCLUB_CLIENT_SECRET: "test-secret", ALLOWED_HACKCLUB_IDS: "ident!friend", RELAY_SHARED_SECRET: "test-relay-key",
  PROVIDERS_JSON: JSON.stringify([{ id: "claude", protocol: "anthropic", baseUrl: "https://relay.test/v1", credential: "RELAY_SHARED_SECRET", models: { claude: "upstream-claude" } }]),
};
let cookie: string;
let token: string;
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([env.DB.prepare('DELETE FROM "user"'), env.DB.prepare("DELETE FROM quota"), env.DB.prepare("DELETE FROM cli_login"), env.DB.prepare("DELETE FROM rate_limit"), env.DB.prepare("DELETE FROM verification")]);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').bind("user-test", "Test Friend", "friend@example.com", now, now).run();
  await env.DB.prepare('INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind("account-test", "ident!friend", "hackclub", "user-test", now, now).run();
  await env.DB.prepare('INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)').bind("session-test", now + 3_600_000, "test-session-token", now, now, "user-test").run();
  cookie = (await serializeSignedCookie("better-auth.session_token", "test-session-token", appEnv.BETTER_AUTH_SECRET)).split(";")[0]!;
  token = (await issueKey(appEnv, "user-test", "Test key")).key;
});

async function call(path: string, init: RequestInit = {}, overrides: Partial<AppEnv> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`http://localhost:8787${path}`, init), { ...appEnv, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const sessionHeaders = () => ({ cookie, origin: appEnv.BETTER_AUTH_URL, "content-type": "application/json" });
const keyHeaders = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("Worker access control and D1", () => {
  it("freezes every route and scheduled write for migration, including authenticated requests", async () => {
    const frozen = { MAINTENANCE_MODE: "true" };
    const before = await env.DB.prepare("SELECT COUNT(*) AS count FROM api_key").first();
    for (const [path, init] of [
      ["/api/auth/ok", {}], ["/v1/models", { headers: keyHeaders() }],
      ["/api/keys", { method: "POST", headers: sessionHeaders(), body: '{"name":"Frozen"}' }],
    ] as const) expect((await call(path, init, frozen)).status).toBe(503);
    expect(await (await call("/health", {}, frozen)).json()).toMatchObject({ serving: false });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM api_key").first()).toEqual(before);
    await env.DB.prepare("INSERT INTO rate_limit (id, key, count, last_request) VALUES ('maintenance-test', 'maintenance-test', 1, 0)").run();
    await worker.scheduled({} as ScheduledController, { ...appEnv, ...frozen });
    expect(await env.DB.prepare("SELECT id FROM rate_limit WHERE id = 'maintenance-test'").first()).not.toBeNull();
  });
  it("authenticates through Better Auth's generated session schema", async () => {
    expect((await call("/api/auth/ok")).status).toBe(200);
    const response = await call("/api/me", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { name: "Test Friend" }, keys: [{ name: "Test key" }], usage: { requestsToday: 0 } });
  });
  it("checks API keys and immediately enforces removal from the allowlist", async () => {
    expect((await call("/v1/models")).status).toBe(401);
    expect((await call("/v1/models", { headers: keyHeaders() })).status).toBe(200);
    expect((await call("/v1/models", { headers: { "x-api-key": token } })).status).toBe(200);
    expect((await call("/v1/models", { headers: keyHeaders() }, { ALLOWED_HACKCLUB_IDS: "" })).status).toBe(403);
    expect((await call("/api/me", { headers: { cookie } }, { ALLOWED_HACKCLUB_IDS: "" })).status).toBe(403);
  });
  it("requires a browser session and same-origin request to issue keys", async () => {
    expect((await call("/api/keys", { method: "POST", headers: keyHeaders(), body: '{"name":"x"}' })).status).toBe(403);
    expect((await call("/api/keys", { method: "POST", headers: { cookie, origin: "https://attacker.example" }, body: '{"name":"x"}' })).status).toBe(403);
    const response = await call("/api/keys", { method: "POST", headers: sessionHeaders(), body: '{"name":"Laptop"}' });
    expect(response.status).toBe(201);
    const created = await response.json<{ id: string; key: string }>();
    const stored = await env.DB.prepare("SELECT key_hash FROM api_key WHERE id = ?").bind(created.id).first<{ key_hash: string }>();
    expect(stored?.key_hash).toBe(await digest(created.key));
    expect((await call(`/api/keys/${created.id}`, { method: "DELETE", headers: sessionHeaders() })).status).toBe(204);
    expect((await call("/v1/models", { headers: { authorization: `Bearer ${created.key}` } })).status).toBe(401);
  });
  it("atomically enforces a shared quota under concurrent requests", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => takeRateLimit(appEnv, "test-quota", 3, 60)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
  });
  it("lets CLI logout revoke only the key used to authenticate it", async () => {
    const other = await issueKey(appEnv, "user-test", "Other device");
    expect((await call("/api/cli/logout", { method: "POST", headers: keyHeaders() })).status).toBe(204);
    expect((await call("/v1/models", { headers: keyHeaders() })).status).toBe(401);
    expect((await call("/v1/models", { headers: { authorization: `Bearer ${other.key}` } })).status).toBe(200);
  });
  it("has a browser-approved, single-use CLI login flow", async () => {
    const start = await call("/api/cli/start", { method: "POST" });
    const pending = await start.json<{ device_code: string; user_code: string }>();
    const poll = () => call("/api/cli/poll", { method: "POST", body: JSON.stringify({ device_code: pending.device_code }) });
    expect((await poll()).status).toBe(202);
    const approve = () => call("/api/cli/approve", { method: "POST", headers: sessionHeaders(), body: JSON.stringify({ user_code: pending.user_code }) });
    expect((await approve()).status).toBe(200);
    expect((await approve()).status).toBe(400);
    const approved = await poll(); expect(approved.status).toBe(200);
    const data = await approved.json<{ key: string }>();
    expect((await call("/v1/models", { headers: { authorization: `Bearer ${data.key}` } })).status).toBe(200);
    expect((await poll()).status).toBe(400);
  });
  it("cleans expired quota, login and auth-rate records", async () => {
    await env.DB.prepare("INSERT INTO quota VALUES ('old', 1, 1, 1)").run();
    await worker.scheduled({} as ScheduledController, appEnv);
    expect(await env.DB.prepare("SELECT * FROM quota WHERE bucket = 'old'").first()).toBeNull();
  });
});

describe("Worker generation routes", () => {
  it.each([
    ["/v1/messages", { model: "claude", max_tokens: 100, messages: [{ role: "user", content: "Hello" }] }, "message"],
    ["/v1/chat/completions", { model: "claude", messages: [{ role: "user", content: "Hello" }] }, "chat.completion"],
    ["/v1/responses", { model: "claude", input: "Hello" }, "response"],
  ])("serves %s and sends only the relay credential upstream", async (path, body, type) => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(anthropicFixture(), { headers: { "content-type": "text/event-stream" } }));
    const response = await call(String(path), { method: "POST", headers: { ...keyHeaders(), cookie: "do-not-forward" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const result = await response.json<{ type?: string; object?: string }>();
    expect(result.object ?? result.type).toBe(type);
    const outbound = upstream.mock.calls[0]![1]!;
    const headers = new Headers(outbound.headers);
    expect(headers.get("authorization")).toBe("Bearer test-relay-key"); expect(headers.has("cookie")).toBe(false);
    expect(JSON.parse(outbound.body as string).model).toBe("upstream-claude");
  });
  it("streams Responses API output and retains tool call IDs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(anthropicFixture(true), { headers: { "content-type": "text/event-stream" } }));
    const response = await call("/v1/responses", { method: "POST", headers: keyHeaders(), body: JSON.stringify({ model: "claude", input: "Read", stream: true, tools: [{ type: "function", name: "read_file" }] }) });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text(); expect(body).toContain("response.completed"); expect(body).toContain("call_demo");
  });
  it.each(["anthropic", "openai-chat"])("allows native Codex's disabled reasoning settings for %s", async (protocol) => {
    const overrides = { PROVIDERS_JSON: JSON.stringify([{ id: "claude", protocol, baseUrl: "https://relay.test/v1",
      credential: "RELAY_SHARED_SECRET", models: { claude: "upstream-model" } }]) };
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("upstream busy", { status: 429 }));
    for (const reasoning of [{}, { effort: "none", summary: "none" }, { summary: "auto" }]) {
      const response = await call("/v1/responses", { method: "POST", headers: keyHeaders(),
        body: JSON.stringify({ model: "claude", input: "Hello", reasoning }) }, overrides);
      // Reaching the provider proves the neutral native defaults were accepted.
      expect(response.status).toBe(429);
    }
    expect(upstream).toHaveBeenCalledTimes(3);
    for (const [, init] of upstream.mock.calls) expect(JSON.parse(String(init?.body))).not.toHaveProperty("reasoning");
  });
  it.each(["anthropic", "openai-chat"])("rejects active unsupported reasoning controls for %s before forwarding", async (protocol) => {
    const overrides = { PROVIDERS_JSON: JSON.stringify([{ id: "claude", protocol, baseUrl: "https://relay.test/v1",
      credential: "RELAY_SHARED_SECRET", models: { claude: "upstream-model" } }]) };
    const upstream = vi.spyOn(globalThis, "fetch");
    for (const reasoning of [{ effort: "high" }, { summary: "concise" }, { context: "auto" }]) {
      const response = await call("/v1/responses", { method: "POST", headers: keyHeaders(),
        body: JSON.stringify({ model: "claude", input: "Hello", reasoning }) }, overrides);
      expect(response.status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it("returns upstream rate limits before committing an SSE response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private upstream details", { status: 429, headers: { "retry-after": "9" } }));
    const response = await call("/v1/responses", { method: "POST", headers: keyHeaders(), body: '{"model":"claude","input":"hello","stream":true}' });
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("9");
    expect(await response.text()).not.toContain("private upstream details");
  });
  it("does not follow upstream redirects with a credential", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://different.test/" } }));
    const response = await call("/v1/responses", { method: "POST", headers: keyHeaders(), body: '{"model":"claude","input":"hello"}' });
    expect(response.status).toBe(502);
    expect(upstream.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported options and oversized bodies without forwarding", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    expect((await call("/v1/responses", { method: "POST", headers: keyHeaders(), body: '{"model":"claude","input":"hi","previous_response_id":"x"}' })).status).toBe(400);
    expect((await call("/v1/responses", { method: "POST", headers: keyHeaders(), body: JSON.stringify({ model: "claude", input: "a".repeat(1_048_577) }) })).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("Hack Club OAuth integration", () => {
  it("uses PKCE and creates a real Better Auth session through the callback", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://auth.hackclub.com/oauth/token") return Response.json({ access_token: "test-hackclub-token", token_type: "Bearer", expires_in: 600, scope: "email name" });
      if (url === "https://auth.hackclub.com/api/v1/me") return Response.json({ identity: { id: "ident!newfriend", primary_email: "new@example.com", first_name: "New", last_name: "Friend" } });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const overrides = { ALLOWED_HACKCLUB_IDS: "ident!newfriend" };
    const start = await call("/api/auth/sign-in/social", { method: "POST", headers: { origin: appEnv.BETTER_AUTH_URL, "content-type": "application/json" }, body: '{"provider":"hackclub","callbackURL":"/"}' }, overrides);
    expect(start.status).toBe(200);
    const destination = new URL((await start.json<{ url: string }>()).url);
    expect(destination.origin).toBe("https://auth.hackclub.com");
    expect(destination.searchParams.get("code_challenge_method")).toBe("S256");
    expect(destination.searchParams.get("redirect_uri")).toBe("http://localhost:8787/api/auth/callback/hackclub");
    const stateCookie = start.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const callback = await call(`/api/auth/callback/hackclub?code=mock-code&state=${encodeURIComponent(destination.searchParams.get("state")!)}`, { headers: { cookie: stateCookie } }, overrides);
    expect(callback.status).toBe(302);
    const sessionCookie = callback.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const profile = await call("/api/me", { headers: { cookie: sessionCookie } }, overrides);
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ user: { email: "new@example.com" } });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
