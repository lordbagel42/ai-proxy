import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { codexModelCatalog, parseCodexModels } from "../src/codex/models";
import { disconnectConnection } from "../src/codex/connection";
import { seal } from "../src/codex/vault";
import type { AppEnv } from "../src/env";

const appEnv: AppEnv = {
  ...env, BETTER_AUTH_SECRET: "test-models-not-production", HACKCLUB_CLIENT_ID: "test", HACKCLUB_CLIENT_SECRET: "test",
  OWNER_HACKCLUB_ID: "ident!catalog-owner", CODEX_TOKEN_KEY: Buffer.from(new Uint8Array(32).fill(9)).toString("base64url"),
};
const model = (slug = "upstream-model", extra: Record<string, unknown> = {}) => ({
  slug, display_name: "Discovered model", description: "From the account catalog", default_reasoning_level: "high",
  supported_reasoning_levels: [{ effort: "high", description: "Detailed reasoning" }], shell_type: "unified_exec", visibility: "list",
  supported_in_api: false, priority: 5, support_verbosity: true, default_verbosity: "low", apply_patch_tool_type: "freeform",
  truncation_policy: { mode: "tokens", limit: 10_000 }, context_window: 272_000, experimental_supported_tools: [],
  input_modalities: ["text", "image"], model_messages: { instructions_template: "Native model instructions" }, ...extra,
});
const accountId = "private-catalog-account";
let accessToken: string;
const token = (tag = "first") => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: accountId }, tag,
})).toString("base64url")}.fake-signature`;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([env.DB.prepare("DELETE FROM codex_connection"), env.DB.prepare("DELETE FROM codex_model_cache")]);
  accessToken = token();
  const encrypted = await seal(appEnv, "tokens", { accessToken, refreshToken: "private-refresh", accountId, expiresAt: Date.now() + 3600_000 });
  await env.DB.prepare("INSERT INTO codex_connection (id, owner_identity, credentials, expires_at, updated_at) VALUES ('codex', ?, ?, ?, ?)")
    .bind(appEnv.OWNER_HACKCLUB_ID, encrypted, Date.now() + 3600_000, Date.now()).run();
});

async function discover(options: Parameters<typeof codexModelCatalog>[2] = {}) {
  const ctx = createExecutionContext();
  try { return await codexModelCatalog(appEnv, ctx, options); }
  finally { await waitOnExecutionContext(ctx); }
}
const stub = (...responses: Response[]) => {
  const mocked = vi.spyOn(globalThis, "fetch");
  for (const response of responses) mocked.mockResolvedValueOnce(response);
  return mocked;
};

describe("account Codex model discovery", () => {
  it("loads the native account catalog and caches it without exposing credentials", async () => {
    const fetcher = stub(Response.json({ models: [model()], account_id: accountId, access_token: "private-upstream-extra" }));
    const first = await discover();
    expect(first.defaultModel).toBe("upstream-model");
    expect(first.models[0]).toMatchObject({ slug: "upstream-model", supported_in_api: false, context_window: 272_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.154.0");
    expect(options?.redirect).toBe("manual");
    const headers = new Headers(options?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("ChatGPT-Account-ID")).toBe(accountId);
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("user-agent")).toBe("codex_cli_rs/0.154.0 (ai-proxy)");
    expect(await discover()).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toMatch(/private|access_token|refresh_token|account_id/);
    const row = await env.DB.prepare("SELECT catalog FROM codex_model_cache").first<{ catalog: string }>();
    expect(row?.catalog).not.toMatch(/private|access_token|refresh_token|account_id/);
  });

  it("chooses the first visible model by upstream priority and retains hidden capability metadata", async () => {
    stub(Response.json({ models: [model("later", { priority: 9 }), model("hidden", { priority: 0, visibility: "hide" }), model("preferred", { priority: 1 })] }));
    const result = await discover();
    expect(result.models.map((entry) => entry.slug)).toEqual(["hidden", "preferred", "later"]);
    expect(result.defaultModel).toBe("preferred");
  });

  it("has no invented default when the upstream returns no visible models", async () => {
    stub(Response.json({ models: [model("hidden", { visibility: "hide" })] }));
    expect((await discover()).defaultModel).toBeNull();
  });

  it("strips unknown nested fields while retaining native model instructions and approval capabilities", () => {
    const result = parseCodexModels({ models: [model("safe", {
      access_token: "secret", account: { email: "private@example.com" },
      model_messages: { instructions_template: "native instructions", email: "private@example.com", permissions: { read_only: "Read only", token: "secret" } },
      guardian: { shell: "synchronous", account_id: "secret" },
      supported_reasoning_levels: [{ effort: "ultra", description: "Thorough", token: "secret" }],
    })] });
    expect(result[0]).toMatchObject({ guardian: { shell: "synchronous" }, model_messages: { instructions_template: "native instructions", permissions: { read_only: "Read only" } } });
    expect(JSON.stringify(result)).not.toMatch(/secret|private@example.com/);
  });

  it.each([
    { models: [model("same"), model("same")] }, { models: [{ slug: "incomplete" }] },
    { models: [model("../invalid")] }, { models: [model("bad", { context_window: -1 })] }, {},
  ])("rejects invalid native catalogs without returning upstream details", async (body) => {
    stub(Response.json(body));
    await expect(discover()).rejects.toMatchObject({ status: 502, code: "codex_models_invalid" });
    expect(await env.DB.prepare("SELECT count(*) n FROM codex_model_cache").first("n")).toBe(0);
  });

  it("reports browser challenges during discovery without logging upstream content", async () => {
    const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
    stub(new Response("private challenge page with account details", { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } }));
    await expect(discover()).rejects.toMatchObject({ status: 502, code: "codex_upstream_challenge" });
    expect(logs).toHaveBeenCalledOnce();
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private|account details/);
  });

  it("refetches expired, invalid, and manually refreshed cache entries", async () => {
    const fetcher = stub(Response.json({ models: [model("first")] }), Response.json({ models: [model("second")] }), Response.json({ models: [model("third")] }), Response.json({ models: [model("fourth")] }));
    await discover();
    await env.DB.prepare("UPDATE codex_model_cache SET expires_at = 0").run();
    expect((await discover()).defaultModel).toBe("second");
    await env.DB.prepare("UPDATE codex_model_cache SET catalog = 'broken'").run();
    expect((await discover()).defaultModel).toBe("third");
    expect((await discover({ forceRefresh: true })).defaultModel).toBe("fourth");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not use catalog cache after disconnection or return a pending fetch after disconnection", async () => {
    stub(Response.json({ models: [model()] }));
    await discover();
    await disconnectConnection(appEnv);
    await expect(discover()).rejects.toMatchObject({ code: "codex_reauthentication_required" });
    await env.DB.prepare("UPDATE codex_connection SET credentials = ?, needs_reconnect = 0").bind(await seal(appEnv, "tokens", { accessToken: token(), refreshToken: "private-refresh", accountId, expiresAt: Date.now() + 3600_000 })).run();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => { await disconnectConnection(appEnv); return Response.json({ models: [model("stale")] }); });
    await expect(discover()).rejects.toMatchObject({ code: "codex_busy" });
  });

  it("invalidates cache when connection ownership/version changes", async () => {
    const fetcher = stub(Response.json({ models: [model("first")] }), Response.json({ models: [model("second")] }));
    await discover();
    await env.DB.prepare("UPDATE codex_connection SET version = version + 1").run();
    expect((await discover()).defaultModel).toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await env.DB.prepare("UPDATE codex_connection SET owner_identity = 'ident!someone-else'").run();
    await expect(discover()).rejects.toMatchObject({ code: "configuration_error" });
  });

  it("refreshes a rejected token once and caches against the rotated credential version", async () => {
    const rotated = token("rotated");
    const fetcher = stub(new Response("private rejection", { status: 401 }), Response.json({ access_token: rotated, refresh_token: "new-private-refresh" }), Response.json({ models: [model()] }));
    await discover();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://auth.openai.com/oauth/token");
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("authorization")).toBe(`Bearer ${rotated}`);
    expect(await env.DB.prepare("SELECT connection_version FROM codex_model_cache").first("connection_version")).toBe(1);
  });

  it("marks repeated unauthorized discovery for reconnection without returning upstream bodies", async () => {
    stub(new Response("private rejection", { status: 401 }), Response.json({ access_token: token("rotated"), refresh_token: "new-private-refresh" }), new Response("private rejection", { status: 401 }));
    await expect(discover()).rejects.toMatchObject({ status: 503, code: "codex_reauthentication_required" });
    expect(await env.DB.prepare("SELECT needs_reconnect FROM codex_connection").first("needs_reconnect")).toBe(1);
  });

  it.each([302, 403, 500])("does not follow redirects or disclose upstream HTTP %i error bodies", async (status) => {
    const fetcher = stub(new Response("private upstream account details", { status, headers: { location: "https://untrusted.example/" } }));
    await expect(discover()).rejects.toMatchObject({ status: 502, message: status === 403 ? "ChatGPT denied the gateway request (HTTP 403)." : `The ChatGPT model catalog returned HTTP ${status}.` });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("handles rate limits without preserving arbitrary upstream headers", async () => {
    stub(new Response("private quota", { status: 429, headers: { "retry-after": "private" } }));
    await expect(discover()).rejects.toMatchObject({ status: 429, retryAfter: "5" });
  });

  it("bounds bytes before parsing a streamed catalog", async () => {
    let cancelled = false;
    stub(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } })));
    await expect(discover()).rejects.toMatchObject({ code: "codex_models_unavailable" });
    expect(cancelled).toBe(true);
  });

  it("cancels a stalled response body when the caller aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      setTimeout(() => controller.abort(), 10);
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    });
    await expect(discover({ signal: controller.signal })).rejects.toMatchObject({ code: "codex_models_unavailable" });
    expect(cancelled).toBe(true);
  });
});
