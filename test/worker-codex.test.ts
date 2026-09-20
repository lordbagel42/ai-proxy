import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSignedCookie } from "better-call";
import worker from "../src/worker";
import { issueKey } from "../src/access";
import { sse } from "../src/core/sse";
import type { AppEnv } from "../src/env";

const appEnv: AppEnv = {
  ...env,
  BETTER_AUTH_URL: "http://localhost:8787",
  BETTER_AUTH_SECRET: "worker-codex-tests-secret-not-for-real-use-12345",
  HACKCLUB_CLIENT_ID: "test-client",
  HACKCLUB_CLIENT_SECRET: "test-secret",
  ALLOWED_HACKCLUB_IDS: "ident!owner,ident!friend",
  OWNER_HACKCLUB_ID: "ident!owner",
  CODEX_TOKEN_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"),
  PROVIDERS_JSON: JSON.stringify([{ id: "codex", protocol: "codex", models: { codex: "gpt-5.6-terra" } }]),
};
let ownerCookie: string;
let friendCookie: string;
let ownerKey: string;
let friendKey: string;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM "user"'),
    env.DB.prepare("DELETE FROM quota"),
    env.DB.prepare("DELETE FROM cli_login"),
    env.DB.prepare("DELETE FROM rate_limit"),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM codex_connection"),
    env.DB.prepare("DELETE FROM codex_request"),
  ]);
  const now = Date.now();
  for (const role of ["owner", "friend"]) {
    await env.DB.prepare('INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .bind(`user-${role}`, `Test ${role}`, `${role}@example.com`, now, now).run();
    await env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(`account-${role}`, `ident!${role}`, "hackclub", `user-${role}`, now, now).run();
    await env.DB.prepare("INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(`session-${role}`, now + 3_600_000, `session-token-${role}`, now, now, `user-${role}`).run();
  }
  ownerCookie = (await serializeSignedCookie("better-auth.session_token", "session-token-owner", appEnv.BETTER_AUTH_SECRET)).split(";")[0]!;
  friendCookie = (await serializeSignedCookie("better-auth.session_token", "session-token-friend", appEnv.BETTER_AUTH_SECRET)).split(";")[0]!;
  ownerKey = (await issueKey(appEnv, "user-owner", "Owner CLI")).key;
  friendKey = (await issueKey(appEnv, "user-friend", "Friend CLI")).key;
});

async function call(path: string, init: RequestInit = {}, overrides: Partial<AppEnv> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`http://localhost:8787${path}`, init), { ...appEnv, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const browserHeaders = (cookie = ownerCookie) => ({ cookie, origin: appEnv.BETTER_AUTH_URL, "content-type": "application/json" });
const keyHeaders = (key = friendKey) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });

function tokenFor(accountId: string, expiration = Math.floor(Date.now() / 1000) + 3600): string {
  return [
    { alg: "RS256", typ: "JWT" },
    { exp: expiration, "https://api.openai.com/auth": { chatgpt_account_id: accountId } },
  ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".test-signature";
}

function responseFixture() {
  const id = "resp_worker_codex";
  const itemId = "msg_worker_codex";
  const part = { type: "output_text", text: "Hello from the Worker", annotations: [] };
  const item = { type: "message", id: itemId, role: "assistant", content: [part], status: "completed" };
  const coords = { output_index: 0, item_id: itemId, content_index: 0 };
  const events = [
    { type: "response.created", response: { id, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
    { type: "response.content_part.added", ...coords, part: { ...part, text: "" } },
    { type: "response.output_text.delta", ...coords, delta: part.text },
    { type: "response.output_text.done", ...coords, text: part.text },
    { type: "response.content_part.done", ...coords, part },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  return new Response(events.map((event, sequence_number) => sse({ ...event, sequence_number }, event.type)).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const endpoint = {
  start: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  poll: "https://auth.openai.com/api/accounts/deviceauth/token",
  token: "https://auth.openai.com/oauth/token",
  responses: "https://chatgpt.com/backend-api/codex/responses",
};
const deviceAuthId = "private-device-auth-id";
const initialRefreshToken = "private-initial-refresh-token";
const nextRefreshToken = "private-rotated-refresh-token";
type MockOptions = {
  pending?: boolean;
  lifetimeSeconds?: number;
  poll?: () => Promise<Response>;
  refresh?: () => Promise<Response>;
  exchange?: () => Response | Promise<Response>;
  refreshFailure?: boolean;
  generation?: (request: Request, count: number) => Response | Promise<Response>;
};

function mockCodex(options: MockOptions = {}) {
  const originalAccessToken = tokenFor("chatgpt-test-account", Math.floor(Date.now() / 1000) + (options.lifetimeSeconds ?? 3600));
  const refreshedAccessToken = tokenFor("chatgpt-test-account", Math.floor(Date.now() / 1000) + 7200);
  const requests: Request[] = [];
  let generations = 0;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    if (request.url === endpoint.start) return Response.json({ device_auth_id: deviceAuthId, user_code: "ABCD-EFGH", interval: 5 });
    if (request.url === endpoint.poll) {
      if (options.poll) return options.poll();
      if (options.pending) return Response.json({ error: "authorization_pending", private: "untrusted OAuth detail" }, { status: 403 });
      return Response.json({ authorization_code: "test-authorization-code", code_verifier: "test-code-verifier" });
    }
    if (request.url === endpoint.token) {
      const raw = new TextDecoder().decode(await request.arrayBuffer());
      const body = request.headers.get("content-type")?.includes("application/json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      if (body.grant_type === "refresh_token") {
        if (options.refresh) return options.refresh();
        if (options.refreshFailure) return Response.json({ error: "invalid_grant", error_description: "private expired refresh credential" }, { status: 401 });
        return Response.json({ access_token: refreshedAccessToken, refresh_token: nextRefreshToken, id_token: refreshedAccessToken, expires_in: 7200 });
      }
      if (options.exchange) return options.exchange();
      return Response.json({ access_token: originalAccessToken, refresh_token: initialRefreshToken, id_token: originalAccessToken, expires_in: 3600 });
    }
    if (request.url === endpoint.responses) return options.generation ? options.generation(request, ++generations) : responseFixture();
    throw new Error(`Unexpected fetch URL: ${request.url}`);
  });
  return { fetch, requests, originalAccessToken, refreshedAccessToken };
}

async function connectCodex() {
  const started = await call("/api/admin/codex/start", { method: "POST", headers: browserHeaders() });
  expect(started.status).toBe(200);
  await env.DB.prepare("UPDATE codex_connection SET next_poll_at = 0 WHERE id = 'codex'").run();
  const connected = await call("/api/admin/codex/poll", { method: "POST", headers: browserHeaders() });
  expect(connected.status).toBe(200);
  expect(await connected.json()).toMatchObject({ connected: true, pending: null, needsReconnect: false });
}

const generate = (overrides: Partial<AppEnv> = {}) => call("/v1/responses", {
  method: "POST", headers: keyHeaders(), body: JSON.stringify({ model: "codex", input: "Hello" }),
}, overrides);

interface BrowserPending { kind: "browser"; authorizationUrl: string; expiresAt: number }
async function startBrowserLogin() {
  const response = await call("/api/admin/codex/browser/start", { method: "POST", headers: browserHeaders() });
  expect(response.status).toBe(200);
  const status = await response.json<{ connected: boolean; pending: BrowserPending }>();
  expect(status.pending.kind).toBe("browser");
  const authorize = new URL(status.pending.authorizationUrl);
  const callback = new URL("http://localhost:1455/auth/callback");
  callback.searchParams.set("code", "browser-authorization-code");
  callback.searchParams.set("state", authorize.searchParams.get("state")!);
  return { status, authorize, callback };
}
const completeBrowserLogin = (callbackUrl: string) => call("/api/admin/codex/browser/complete", {
  method: "POST", headers: browserHeaders(), body: JSON.stringify({ callbackUrl }),
});

describe("owner-only Codex connection", () => {
  it("derives owner status from the Hack Club identity", async () => {
    expect(await (await call("/api/me", { headers: { cookie: ownerCookie } })).json()).toMatchObject({ isOwner: true });
    expect(await (await call("/api/me", { headers: { cookie: friendCookie } })).json()).toMatchObject({ isOwner: false });
    expect(await (await call("/api/me", { headers: { cookie: ownerCookie } }, { OWNER_HACKCLUB_ID: "ident!another-owner" })).json()).toMatchObject({ isOwner: false });
  });

  it.each([
    ["GET", "/api/admin/codex"],
    ["POST", "/api/admin/codex/start"],
    ["POST", "/api/admin/codex/poll"],
    ["POST", "/api/admin/codex/browser/start"],
    ["POST", "/api/admin/codex/browser/complete"],
    ["DELETE", "/api/admin/codex"],
  ])("denies regular members and proxy keys for %s %s", async (method, path) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await call(path, { method, headers: browserHeaders(friendCookie) })).status).toBe(403);
    expect((await call(path, { method, headers: { ...keyHeaders(ownerKey), origin: appEnv.BETTER_AUTH_URL } })).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/api/admin/codex/start"],
    ["POST", "/api/admin/codex/poll"],
    ["POST", "/api/admin/codex/browser/start"],
    ["POST", "/api/admin/codex/browser/complete"],
    ["DELETE", "/api/admin/codex"],
  ])("rejects a cross-origin owner request for %s %s", async (method, path) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await call(path, { method, headers: { ...browserHeaders(), origin: "https://attacker.example" } })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a disconnected account without contacting upstream", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await call("/api/admin/codex", { headers: browserHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: false, pending: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("encrypts the pending login and enforces the upstream polling interval", async () => {
    const { fetch } = mockCodex();
    const response = await call("/api/admin/codex/start", { method: "POST", headers: browserHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connected: false,
      pending: { userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device", intervalSeconds: 5 },
    });
    const stored = await env.DB.prepare("SELECT * FROM codex_connection WHERE id = 'codex'").first();
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(deviceAuthId);
    expect(JSON.stringify(stored)).not.toContain("ABCD-EFGH");
    expect((await call("/api/admin/codex/poll", { method: "POST", headers: browserHeaders() })).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains pending state while OpenAI awaits approval without exposing upstream details", async () => {
    const { fetch } = mockCodex({ pending: true });
    await call("/api/admin/codex/start", { method: "POST", headers: browserHeaders() });
    await env.DB.prepare("UPDATE codex_connection SET next_poll_at = 0 WHERE id = 'codex'").run();
    const response = await call("/api/admin/codex/poll", { method: "POST", headers: browserHeaders() });
    expect(response.status).toBe(200);
    const status = await response.text();
    expect(JSON.parse(status)).toMatchObject({ connected: false, pending: { userCode: "ABCD-EFGH" } });
    expect(status).not.toContain("untrusted OAuth detail");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("exchanges the device code and stores only encrypted account credentials", async () => {
    const mocked = mockCodex();
    await connectCodex();
    const stored = await env.DB.prepare("SELECT * FROM codex_connection WHERE id = 'codex'").first();
    const serialized = JSON.stringify(stored);
    for (const secret of [mocked.originalAccessToken, initialRefreshToken, deviceAuthId, "chatgpt-test-account"]) expect(serialized).not.toContain(secret);
    expect(stored).toMatchObject({ pending: null, needs_reconnect: 0, owner_identity: "ident!owner" });
    const exchange = mocked.requests.find(request => request.url === endpoint.token)!;
    expect(Object.fromEntries(new URLSearchParams(new TextDecoder().decode(await exchange.arrayBuffer())))).toMatchObject({
      grant_type: "authorization_code", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", code: "test-authorization-code",
      code_verifier: "test-code-verifier", redirect_uri: "https://auth.openai.com/deviceauth/callback",
    });
    const status = await (await call("/api/admin/codex", { headers: browserHeaders() })).text();
    expect(JSON.parse(status)).toMatchObject({ connected: true, pending: null });
    for (const secret of [mocked.originalAccessToken, initialRefreshToken, "chatgpt-test-account"]) expect(status).not.toContain(secret);
    expect(mocked.requests.every(request => request.redirect === "manual")).toBe(true);
  });

  it("disconnects the backend so existing friend keys immediately lose model access", async () => {
    const mocked = mockCodex();
    await connectCodex();
    expect((await call("/api/admin/codex", { method: "DELETE", headers: browserHeaders() })).status).toBe(204);
    const status = await call("/api/admin/codex", { headers: browserHeaders() });
    expect(await status.json()).toMatchObject({ connected: false, pending: null });
    const callsBefore = mocked.fetch.mock.calls.length;
    expect((await generate()).status).toBe(503);
    expect(mocked.fetch).toHaveBeenCalledTimes(callsBefore);
    const stored = await env.DB.prepare("SELECT credentials, pending FROM codex_connection WHERE id = 'codex'").first();
    expect(stored === null || (stored.credentials === null && stored.pending === null)).toBe(true);
  });

  it("serializes simultaneous polling so the device authorization is exchanged once", async () => {
    let finishPoll!: (response: Response) => void;
    let pollStarted!: () => void;
    const started = new Promise<void>(resolve => { pollStarted = resolve; });
    const upstreamPoll = new Promise<Response>(resolve => { finishPoll = resolve; });
    const mocked = mockCodex({ poll: () => { pollStarted(); return upstreamPoll; } });
    await call("/api/admin/codex/start", { method: "POST", headers: browserHeaders() });
    await env.DB.prepare("UPDATE codex_connection SET next_poll_at = 0 WHERE id = 'codex'").run();
    const first = call("/api/admin/codex/poll", { method: "POST", headers: browserHeaders() });
    await started;
    let second: Response;
    try {
      second = await call("/api/admin/codex/poll", { method: "POST", headers: browserHeaders() });
    } finally {
      finishPoll(Response.json({ authorization_code: "test-authorization-code", code_verifier: "test-code-verifier" }));
    }
    expect(second.status).toBe(200);
    expect((await first).status).toBe(200);
    expect(mocked.requests.filter(request => request.url === endpoint.poll)).toHaveLength(1);
    expect(mocked.requests.filter(request => request.url === endpoint.token)).toHaveLength(1);
  });

  it("prevents an in-flight login from restoring credentials after disconnect", async () => {
    let finishPoll!: (response: Response) => void;
    let pollStarted!: () => void;
    const started = new Promise<void>(resolve => { pollStarted = resolve; });
    const upstreamPoll = new Promise<Response>(resolve => { finishPoll = resolve; });
    mockCodex({ poll: () => { pollStarted(); return upstreamPoll; } });
    await call("/api/admin/codex/start", { method: "POST", headers: browserHeaders() });
    await env.DB.prepare("UPDATE codex_connection SET next_poll_at = 0 WHERE id = 'codex'").run();
    const inflight = call("/api/admin/codex/poll", { method: "POST", headers: browserHeaders() });
    await started;
    try {
      expect((await call("/api/admin/codex", { method: "DELETE", headers: browserHeaders() })).status).toBe(204);
    } finally {
      finishPoll(Response.json({ authorization_code: "test-authorization-code", code_verifier: "test-code-verifier" }));
    }
    await inflight;
    expect(await (await call("/api/admin/codex", { headers: browserHeaders() })).json()).toMatchObject({ connected: false, pending: null });
    expect((await generate()).status).toBe(503);
  });
});

describe("browser Codex OAuth", () => {
  it("creates PKCE authorization without an upstream fetch and exposes no verifier", async () => {
    const mocked = mockCodex();
    const { status, authorize } = await startBrowserLogin();
    expect(authorize.origin).toBe("https://auth.openai.com");
    expect(authorize.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code", client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirect_uri: "http://localhost:1455/auth/callback", code_challenge_method: "S256",
    });
    expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "offline_access"]));
    expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(status.pending).sort()).toEqual(["authorizationUrl", "expiresAt", "kind"]);
    expect(authorize.searchParams.has("code_verifier")).toBe(false);
    const stored = await env.DB.prepare("SELECT pending FROM codex_connection WHERE id = 'codex'").first<{ pending: string }>();
    expect(stored?.pending).toMatch(/^v1\./);
    expect(stored?.pending).not.toContain(authorize.searchParams.get("state")!);
    expect(stored?.pending).not.toContain(authorize.searchParams.get("code_challenge")!);
    expect(mocked.fetch).not.toHaveBeenCalled();
  });

  it("exchanges the matching callback once using the encrypted PKCE verifier", async () => {
    const mocked = mockCodex();
    const { status, authorize, callback } = await startBrowserLogin();
    const encrypted = (await env.DB.prepare("SELECT pending FROM codex_connection WHERE id = 'codex'").first<{ pending: string }>())!.pending;
    const response = await completeBrowserLogin(callback.toString());
    expect(response.status).toBe(200);
    const completed = await response.text();
    expect(JSON.parse(completed)).toMatchObject({ connected: true, pending: null, needsReconnect: false });
    expect(mocked.requests).toHaveLength(1);
    expect(mocked.requests[0]!.url).toBe(endpoint.token);
    expect(mocked.requests[0]!.redirect).toBe("manual");
    const exchange = new URLSearchParams(new TextDecoder().decode(await mocked.requests[0]!.arrayBuffer()));
    expect(Object.fromEntries(exchange)).toMatchObject({
      grant_type: "authorization_code", code: "browser-authorization-code", client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirect_uri: "http://localhost:1455/auth/callback",
    });
    const verifier = exchange.get("code_verifier")!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(Buffer.from(hash).toString("base64url")).toBe(authorize.searchParams.get("code_challenge"));
    expect(encrypted).not.toContain(verifier);
    expect(JSON.stringify(status)).not.toContain(verifier);
    for (const secret of [verifier, mocked.originalAccessToken, initialRefreshToken]) expect(completed).not.toContain(secret);
    const stored = await env.DB.prepare("SELECT credentials, pending FROM codex_connection WHERE id = 'codex'").first<{ credentials: string; pending: null }>();
    expect(stored?.pending).toBeNull();
    expect(stored?.credentials).not.toContain(mocked.originalAccessToken);
    expect(stored?.credentials).not.toContain(initialRefreshToken);
    expect((await completeBrowserLogin(callback.toString())).status).toBe(400);
    expect(mocked.requests).toHaveLength(1);
  });

  it.each([
    ["different host", (url: URL) => { url.hostname = "attacker.example"; }],
    ["IP instead of localhost", (url: URL) => { url.hostname = "127.0.0.1"; }],
    ["different port", (url: URL) => { url.port = "1456"; }],
    ["different scheme", (url: URL) => { url.protocol = "https:"; }],
    ["different path", (url: URL) => { url.pathname = "/unexpected"; }],
    ["URL credentials", (url: URL) => { url.username = "owner"; }],
    ["fragment", (url: URL) => { url.hash = "secret"; }],
    ["wrong state", (url: URL) => { url.searchParams.set("state", "incorrect-state"); }],
    ["missing state", (url: URL) => { url.searchParams.delete("state"); }],
    ["duplicate state", (url: URL) => { url.searchParams.append("state", url.searchParams.get("state")!); }],
    ["missing code", (url: URL) => { url.searchParams.delete("code"); }],
    ["duplicate code", (url: URL) => { url.searchParams.append("code", "another-code"); }],
    ["code plus error", (url: URL) => { url.searchParams.set("error", "access_denied"); }],
  ] as const)("rejects a callback with %s before any upstream request", async (_name, change) => {
    const mocked = mockCodex();
    const { status, callback } = await startBrowserLogin();
    change(callback);
    const response = await completeBrowserLogin(callback.toString());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "codex_callback_invalid" } });
    expect(mocked.fetch).not.toHaveBeenCalled();
    expect(await (await call("/api/admin/codex", { headers: browserHeaders() })).json()).toMatchObject({ pending: status.pending });
  });

  it("expires an unfinished browser login without exchanging its callback", async () => {
    const mocked = mockCodex();
    const { status, callback } = await startBrowserLogin();
    vi.spyOn(Date, "now").mockReturnValue(status.pending.expiresAt + 1);
    expect((await completeBrowserLogin(callback.toString())).status).toBe(410);
    expect(await (await call("/api/admin/codex", { headers: browserHeaders() })).json()).toMatchObject({ connected: false, pending: null });
    expect(mocked.fetch).not.toHaveBeenCalled();
  });

  it("serializes simultaneous callback completion and exchanges the code only once", async () => {
    let finishExchange!: (response: Response) => void;
    let exchangeStarted!: () => void;
    const started = new Promise<void>(resolve => { exchangeStarted = resolve; });
    const exchange = new Promise<Response>(resolve => { finishExchange = resolve; });
    const mocked = mockCodex({ exchange: () => { exchangeStarted(); return exchange; } });
    const { callback } = await startBrowserLogin();
    const first = completeBrowserLogin(callback.toString());
    await started;
    let second: Response;
    try { second = await completeBrowserLogin(callback.toString()); }
    finally { finishExchange(Response.json({ access_token: mocked.originalAccessToken, refresh_token: initialRefreshToken, id_token: mocked.originalAccessToken, expires_in: 3600 })); }
    expect(second.status).toBe(503);
    expect((await first).status).toBe(200);
    expect(mocked.requests.filter(request => request.url === endpoint.token)).toHaveLength(1);
  });

  it("does not restore credentials when disconnected during browser code exchange", async () => {
    let finishExchange!: (response: Response) => void;
    let exchangeStarted!: () => void;
    const started = new Promise<void>(resolve => { exchangeStarted = resolve; });
    const exchange = new Promise<Response>(resolve => { finishExchange = resolve; });
    const mocked = mockCodex({ exchange: () => { exchangeStarted(); return exchange; } });
    const { callback } = await startBrowserLogin();
    const inflight = completeBrowserLogin(callback.toString());
    await started;
    try { expect((await call("/api/admin/codex", { method: "DELETE", headers: browserHeaders() })).status).toBe(204); }
    finally { finishExchange(Response.json({ access_token: mocked.originalAccessToken, refresh_token: initialRefreshToken, id_token: mocked.originalAccessToken, expires_in: 3600 })); }
    expect((await inflight).status).toBe(503);
    expect(await (await call("/api/admin/codex", { headers: browserHeaders() })).json()).toMatchObject({ connected: false, pending: null });
    expect(await env.DB.prepare("SELECT credentials, pending, lock_id FROM codex_connection WHERE id = 'codex'").first()).toEqual({ credentials: null, pending: null, lock_id: null });
  });

  it("preserves the working connection when a new browser authorization fails", async () => {
    const options: MockOptions = {};
    const mocked = mockCodex(options);
    await connectCodex();
    const { callback } = await startBrowserLogin();
    options.exchange = () => Response.json({ error: "invalid_grant", error_description: "private upstream OAuth detail" }, { status: 400 });
    const response = await completeBrowserLogin(callback.toString());
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private upstream OAuth detail");
    expect(await (await call("/api/admin/codex", { headers: browserHeaders() })).json()).toMatchObject({ connected: true, pending: null });
    expect((await generate()).status).toBe(200);
    expect(mocked.requests.find(request => request.url === endpoint.responses)!.headers.get("authorization")).toBe(`Bearer ${mocked.originalAccessToken}`);
  });

  it("prevents stale device polling from overwriting a replacement browser login", async () => {
    let finishPoll!: (response: Response) => void;
    let pollStarted!: () => void;
    const started = new Promise<void>(resolve => { pollStarted = resolve; });
    const poll = new Promise<Response>(resolve => { finishPoll = resolve; });
    const mocked = mockCodex({ poll: () => { pollStarted(); return poll; } });
    await call("/api/admin/codex/start", { method: "POST", headers: browserHeaders() });
    await env.DB.prepare("UPDATE codex_connection SET next_poll_at = 0 WHERE id = 'codex'").run();
    const stalePoll = call("/api/admin/codex/poll", { method: "POST", headers: browserHeaders() });
    await started;
    await env.DB.prepare("UPDATE codex_connection SET lock_expires_at = ? WHERE id = 'codex'").bind(Date.now() - 1).run();
    let replacement: Awaited<ReturnType<typeof startBrowserLogin>>;
    try { replacement = await startBrowserLogin(); }
    finally { finishPoll(Response.json({ authorization_code: "test-authorization-code", code_verifier: "test-code-verifier" })); }
    await stalePoll;
    expect(await (await call("/api/admin/codex", { headers: browserHeaders() })).json()).toMatchObject({ connected: false, pending: replacement.status.pending });
    const previous = mocked.requests.length;
    expect((await call("/api/admin/codex/poll", { method: "POST", headers: browserHeaders() })).status).toBe(200);
    expect(mocked.requests).toHaveLength(previous);
    expect((await completeBrowserLogin(replacement.callback.toString())).status).toBe(200);
  });

  it("invalidates an earlier browser callback when starting a fresh browser login", async () => {
    const mocked = mockCodex();
    const first = await startBrowserLogin();
    const replacement = await startBrowserLogin();
    expect(replacement.authorize.searchParams.get("state")).not.toBe(first.authorize.searchParams.get("state"));
    expect((await completeBrowserLogin(first.callback.toString())).status).toBe(400);
    expect(mocked.fetch).not.toHaveBeenCalled();
    expect((await completeBrowserLogin(replacement.callback.toString())).status).toBe(200);
  });
});

describe("direct Codex generation from the Worker", () => {
  it.each([
    ["/v1/messages", { model: "codex", max_tokens: 100, messages: [{ role: "user", content: "Hello" }] }, "message"],
    ["/v1/chat/completions", { model: "codex", messages: [{ role: "user", content: "Hello" }] }, "chat.completion"],
    ["/v1/responses", { model: "codex", input: "Hello" }, "response"],
  ])("serves %s directly using the owner's encrypted ChatGPT credentials", async (path, body, type) => {
    const mocked = mockCodex();
    await connectCodex();
    const response = await call(String(path), { method: "POST", headers: { ...keyHeaders(), cookie: "private-friend-cookie" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const result = await response.json<{ type?: string; object?: string }>();
    expect(result.object ?? result.type).toBe(type);
    const upstream = mocked.requests.find(request => request.url === endpoint.responses)!;
    expect(upstream.headers.get("authorization")).toBe(`Bearer ${mocked.originalAccessToken}`);
    expect(upstream.headers.get("chatgpt-account-id")).toBe("chatgpt-test-account");
    expect(upstream.headers.get("originator")).toBe("codex_cli_rs");
    expect(upstream.headers.get("user-agent")).toBe("codex_cli_rs/0.154.0 (Cloudflare Workers; ai-proxy)");
    expect(upstream.headers.has("openai-beta")).toBe(false);
    expect(upstream.headers.has("cookie")).toBe(false);
    expect(upstream.redirect).toBe("manual");
    const upstreamBody = await upstream.json<Record<string, unknown>>();
    expect(upstreamBody).toMatchObject({ model: "gpt-5.6-terra", stream: true, store: false });
    expect(upstreamBody).not.toHaveProperty("max_output_tokens");
    expect(JSON.stringify(upstreamBody)).not.toContain(friendKey);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(0);
  });

  it("fails closed if the encryption key or configured owner changes", async () => {
    const mocked = mockCodex();
    await connectCodex();
    const count = mocked.fetch.mock.calls.length;
    expect((await generate({ CODEX_TOKEN_KEY: Buffer.from(new Uint8Array(32).fill(8)).toString("base64url") })).status).toBe(503);
    expect((await generate({ OWNER_HACKCLUB_ID: "ident!friend" })).status).toBe(503);
    expect(mocked.fetch).toHaveBeenCalledTimes(count);
  });

  it("releases its account lease and aborts upstream when streaming is cancelled before consumption", async () => {
    const mocked = mockCodex();
    await connectCodex();
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("http://localhost:8787/v1/responses", {
      method: "POST", headers: keyHeaders(), body: JSON.stringify({ model: "codex", input: "Hello", stream: true }),
    }), appEnv, ctx);
    expect(response.status).toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(1);
    await response.body!.cancel();
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(0);
    expect(mocked.requests.find(request => request.url === endpoint.responses)!.signal.aborted).toBe(true);
  });

  it("releases its account lease when the downstream event stream completes", async () => {
    mockCodex();
    await connectCodex();
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("http://localhost:8787/v1/responses", {
      method: "POST", headers: keyHeaders(), body: JSON.stringify({ model: "codex", input: "Hello", stream: true }),
    }), appEnv, ctx);
    expect(await response.text()).toContain("event: response.completed");
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(0);
  });

  it("refreshes an unauthorized token once, retries, and persists rotated credentials", async () => {
    const mocked = mockCodex({ generation: (_request, count) => count === 1 ? new Response("private expired token detail", { status: 401 }) : responseFixture() });
    await connectCodex();
    const response = await generate();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello from the Worker");
    const upstream = mocked.requests.filter(request => request.url === endpoint.responses);
    expect(upstream.map(request => request.headers.get("authorization"))).toEqual([
      `Bearer ${mocked.originalAccessToken}`, `Bearer ${mocked.refreshedAccessToken}`,
    ]);
    const refresh = mocked.requests.filter(request => request.url === endpoint.token).at(-1)!;
    expect(await refresh.json()).toMatchObject({ grant_type: "refresh_token", refresh_token: initialRefreshToken, client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    const stored = await env.DB.prepare("SELECT credentials FROM codex_connection WHERE id = 'codex'").first();
    expect(JSON.stringify(stored)).not.toContain(nextRefreshToken);
    expect((await generate()).status).toBe(200);
    expect(mocked.requests.filter(request => request.url === endpoint.token)).toHaveLength(2);
    expect(mocked.requests.filter(request => request.url === endpoint.responses).at(-1)?.headers.get("authorization")).toBe(`Bearer ${mocked.refreshedAccessToken}`);
  });

  it("refreshes expiring credentials before sending an inference request", async () => {
    const mocked = mockCodex({ lifetimeSeconds: 30 });
    await connectCodex();
    expect((await generate()).status).toBe(200);
    const upstream = mocked.requests.filter(request => request.url === endpoint.responses);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${mocked.refreshedAccessToken}`);
  });

  it("serializes refreshes when concurrent generation requests reject the same token", async () => {
    let finishRefresh!: (response: Response) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    const upstreamRefresh = new Promise<Response>(resolve => { finishRefresh = resolve; });
    const mocked = mockCodex({
      refresh: () => { refreshStarted(); return upstreamRefresh; },
      generation: request => request.headers.get("authorization") === `Bearer ${mocked.originalAccessToken}`
        ? new Response(null, { status: 401 }) : responseFixture(),
    });
    await connectCodex();
    const first = generate();
    await started;
    let second: Response;
    try { second = await generate(); }
    finally { finishRefresh(Response.json({ access_token: mocked.refreshedAccessToken, refresh_token: nextRefreshToken, id_token: mocked.refreshedAccessToken, expires_in: 7200 })); }
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("2");
    expect((await first).status).toBe(200);
    expect(mocked.requests.filter(request => request.url === endpoint.token)).toHaveLength(2);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(0);
  });

  it("prevents an in-flight refresh from restoring a disconnected account or starting inference", async () => {
    let finishRefresh!: (response: Response) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    const upstreamRefresh = new Promise<Response>(resolve => { finishRefresh = resolve; });
    const mocked = mockCodex({ lifetimeSeconds: 30, refresh: () => { refreshStarted(); return upstreamRefresh; } });
    await connectCodex();
    const inflight = generate();
    await started;
    try {
      expect((await call("/api/admin/codex", { method: "DELETE", headers: browserHeaders() })).status).toBe(204);
    } finally {
      finishRefresh(Response.json({ access_token: mocked.refreshedAccessToken, refresh_token: nextRefreshToken, id_token: mocked.refreshedAccessToken, expires_in: 7200 }));
    }
    expect((await inflight).status).toBe(503);
    expect(await (await call("/api/admin/codex", { headers: browserHeaders() })).json()).toMatchObject({ connected: false, pending: null });
    expect(await env.DB.prepare("SELECT credentials, lock_id FROM codex_connection WHERE id = 'codex'").first()).toMatchObject({ credentials: null, lock_id: null });
    expect(mocked.requests.filter(request => request.url === endpoint.responses)).toHaveLength(0);
    expect((await generate()).status).toBe(503);
    expect(mocked.requests.filter(request => request.url === endpoint.token)).toHaveLength(2);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(0);
  });

  it("fences an expired refresh holder from overwriting credentials or unlocking its replacement", async () => {
    let finishOld!: (response: Response) => void;
    let finishNew!: (response: Response) => void;
    let oldStarted!: () => void;
    let newStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { oldStarted = resolve; });
    const secondStarted = new Promise<void>(resolve => { newStarted = resolve; });
    const oldRefresh = new Promise<Response>(resolve => { finishOld = resolve; });
    const newRefresh = new Promise<Response>(resolve => { finishNew = resolve; });
    let refreshCalls = 0;
    const mocked = mockCodex({ lifetimeSeconds: 30, refresh: () => {
      if (++refreshCalls === 1) { oldStarted(); return oldRefresh; }
      newStarted(); return newRefresh;
    } });
    await connectCodex();
    const oldRequest = generate();
    await firstStarted;
    const original = await env.DB.prepare("SELECT credentials, version, lock_id FROM codex_connection WHERE id = 'codex'")
      .first<{ credentials: string; version: number; lock_id: string }>();
    expect(original?.lock_id).toBeTruthy();
    await env.DB.prepare("UPDATE codex_connection SET lock_expires_at = ? WHERE id = 'codex'").bind(Date.now() - 1).run();
    const newRequest = generate();
    await secondStarted;
    const replacement = await env.DB.prepare("SELECT lock_id FROM codex_connection WHERE id = 'codex'").first<{ lock_id: string }>();
    expect(replacement?.lock_id).toBeTruthy();
    expect(replacement?.lock_id).not.toBe(original?.lock_id);
    const supersededToken = tokenFor("chatgpt-test-account", Math.floor(Date.now() / 1000) + 5400);
    finishOld(Response.json({ access_token: supersededToken, refresh_token: "superseded-refresh-token", id_token: supersededToken, expires_in: 5400 }));
    try {
      expect((await oldRequest).status).toBe(503);
      expect(await env.DB.prepare("SELECT credentials, version, lock_id FROM codex_connection WHERE id = 'codex'").first()).toEqual({
        credentials: original!.credentials, version: original!.version, lock_id: replacement!.lock_id,
      });
    } finally {
      finishNew(Response.json({ access_token: mocked.refreshedAccessToken, refresh_token: nextRefreshToken, id_token: mocked.refreshedAccessToken, expires_in: 7200 }));
    }
    expect((await newRequest).status).toBe(200);
    expect(mocked.requests.filter(request => request.url === endpoint.responses).map(request => request.headers.get("authorization")))
      .toEqual([`Bearer ${mocked.refreshedAccessToken}`]);
    expect(await env.DB.prepare("SELECT lock_id, version FROM codex_connection WHERE id = 'codex'").first())
      .toEqual({ lock_id: null, version: original!.version + 1 });
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(0);
  });

  it("retries a failed account lease cleanup without failing a completed generation", async () => {
    mockCodex();
    await connectCodex();
    let deleteAttempts = 0;
    // Delegate all real D1 work; only the first cleanup DELETE is fault-injected.
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (query: string) => {
          const statement = target.prepare(query);
          if (query !== "DELETE FROM codex_request WHERE id = ?") return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return { async run() {
                if (++deleteAttempts === 1) throw new Error("Injected temporary D1 failure");
                return bound.run();
              } };
            },
          } as D1PreparedStatement;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await generate({ DB: database });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello from the Worker");
    expect(deleteAttempts).toBe(2);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(0);
  });

  it("marks revoked refresh credentials for reconnect and sanitizes the failure", async () => {
    const mocked = mockCodex({ refreshFailure: true, generation: () => new Response("private expired access token", { status: 401 }) });
    await connectCodex();
    const response = await generate();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("private");
    expect(body).not.toContain(initialRefreshToken);
    const status = await (await call("/api/admin/codex", { headers: browserHeaders() })).json();
    expect(status).toMatchObject({ needsReconnect: true });
    expect(mocked.requests.filter(request => request.url === endpoint.responses)).toHaveLength(1);
  });

  it("does not refresh or retry rate-limited inference", async () => {
    const mocked = mockCodex({ generation: () => new Response("private quota detail", { status: 429, headers: { "retry-after": "13" } }) });
    await connectCodex();
    const response = await generate();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("13");
    expect(await response.text()).not.toContain("private quota detail");
    expect(mocked.requests.filter(request => request.url === endpoint.responses)).toHaveLength(1);
    expect(mocked.requests.filter(request => request.url === endpoint.token)).toHaveLength(1);
  });

  it("classifies a browser challenge without refreshing, retrying, or logging provider content", async () => {
    const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mocked = mockCodex({ generation: () => new Response("<html>private challenge cookie and token</html>", {
      status: 403, headers: { "content-type": "text/html; charset=UTF-8", server: "cloudflare", "cf-mitigated": "challenge", "cf-ray": "0123456789abcdef-SJC" },
    }) });
    await connectCodex();
    const response = await generate();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "codex_upstream_challenge" } });
    expect(logs.mock.calls).toEqual([[JSON.stringify({ code: "codex_upstream_rejected", operation: "responses", upstreamStatus: 403,
      contentType: "text/html", server: "cloudflare", challenge: true, upstreamCode: "unknown", cfRay: "0123456789abcdef-SJC" })]]);
    expect(mocked.requests.filter(request => request.url === endpoint.responses)).toHaveLength(1);
    expect(mocked.requests.filter(request => request.url === endpoint.token)).toHaveLength(1);
    expect(await (await call("/api/admin/codex", { headers: browserHeaders() })).json()).toMatchObject({ connected: true, needsReconnect: false });
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(0);
  });

  it("classifies a known regional rejection using only its allowlisted code", async () => {
    const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCodex({ generation: () => Response.json({ error: { code: "unsupported_country_region_territory", message: "private account info" } }, { status: 403 }) });
    await connectCodex();
    const response = await generate();
    expect(await response.json()).toMatchObject({ error: { code: "codex_upstream_region_restricted" } });
    expect(JSON.parse(String(logs.mock.calls[0]?.[0]))).toMatchObject({ upstreamCode: "unsupported_country_region_territory", contentType: "application/json" });
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private account info");
  });

  it("does not expose arbitrary error codes, headers, or an oversized error body", async () => {
    const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCodex({ generation: (_request, count) => Response.json({ error: { code: count === 1 ? "private-secret-code" : "permission_denied", message: "private prompt".repeat(count === 1 ? 1 : 2000) } }, {
      status: 403, headers: { server: "private-header", "cf-ray": "private-header", "cf-mitigated": "private-header" },
    }) });
    await connectCodex();
    for (let i = 0; i < 2; i++) {
      const response = await generate();
      expect(await response.json()).toMatchObject({ error: { code: "codex_upstream_forbidden" } });
    }
    expect(logs.mock.calls.map(call => JSON.parse(String(call[0])).upstreamCode)).toEqual(["unknown", "unknown"]);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private");
  });

  it("does not follow redirects with ChatGPT credentials", async () => {
    const mocked = mockCodex({ generation: () => new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } }) });
    await connectCodex();
    const response = await generate();
    expect(response.status).toBe(502);
    expect(mocked.requests.filter(request => request.url === endpoint.responses)).toHaveLength(1);
    expect(mocked.requests.every(request => request.redirect === "manual")).toBe(true);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request").first<{ count: number }>())?.count).toBe(0);
  });

  it("enforces the shared account's active request limit and ignores expired leases", async () => {
    const mocked = mockCodex();
    await connectCodex();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO codex_request (id, expires_at) VALUES ('active-1', ?)").bind(Date.now() + 60_000),
      env.DB.prepare("INSERT INTO codex_request (id, expires_at) VALUES ('active-2', ?)").bind(Date.now() + 60_000),
    ]);
    const response = await generate();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(mocked.requests.filter(request => request.url === endpoint.responses)).toHaveLength(0);
    await env.DB.prepare("UPDATE codex_request SET expires_at = ? WHERE id = 'active-1'").bind(Date.now() - 1).run();
    expect((await generate()).status).toBe(200);
    expect(mocked.requests.filter(request => request.url === endpoint.responses)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM codex_request WHERE expires_at > ?").bind(Date.now()).first<{ count: number }>())?.count).toBe(1);
  });
});
