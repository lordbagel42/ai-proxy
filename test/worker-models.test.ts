import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSignedCookie } from "better-call";
import worker from "../src/worker";
import { issueKey } from "../src/access";
import { seal } from "../src/codex/vault";
import { modelListing, resolveModel, type ModelListing } from "../src/models";
import type { AppEnv } from "../src/env";

const dynamicProvider = { id: "codex", protocol: "codex", discoverModels: true, models: {} };
const staticProvider = { id: "other", protocol: "openai-responses", baseUrl: "https://api.example/v1", credential: "RELAY_SHARED_SECRET", models: { other: "upstream-other" } };
const appEnv: AppEnv = {
  ...env, BETTER_AUTH_URL: "http://localhost:8787", BETTER_AUTH_SECRET: "test-model-routing-session-secret-1234567",
  HACKCLUB_CLIENT_ID: "test", HACKCLUB_CLIENT_SECRET: "test", ALLOWED_HACKCLUB_IDS: "ident!friend", OWNER_HACKCLUB_ID: "ident!owner",
  CODEX_TOKEN_KEY: Buffer.from(new Uint8Array(32).fill(13)).toString("base64url"), PROVIDERS_JSON: JSON.stringify([dynamicProvider]),
};
const nativeModel = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug, display_name: slug.toUpperCase(), description: "Account model", default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }], shell_type: "unified_exec", visibility: "list",
  supported_in_api: false, priority: 5, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform",
  truncation_policy: { mode: "tokens", limit: 10_000 }, context_window: 272_000, experimental_supported_tools: [],
  model_messages: { instructions_template: "Native instructions" }, ...extra,
});
const discovered = { models: [nativeModel("second", { priority: 2 }), nativeModel("hidden", { priority: 0, visibility: "hide" }), nativeModel("preferred", { priority: 1 })] };
let cookie: string;
let key: string;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM "user"'), env.DB.prepare("DELETE FROM quota"), env.DB.prepare("DELETE FROM rate_limit"),
    env.DB.prepare("DELETE FROM codex_connection"), env.DB.prepare("DELETE FROM codex_model_cache"), env.DB.prepare("DELETE FROM proxy_member"),
  ]);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .bind("catalog-user", "Catalog Friend", "friend@example.com", now, now).run();
  await env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("catalog-account", "ident!friend", "hackclub", "catalog-user", now, now).run();
  await env.DB.prepare("INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("catalog-session", now + 3600_000, "catalog-session-token", now, now, "catalog-user").run();
  cookie = (await serializeSignedCookie("better-auth.session_token", "catalog-session-token", appEnv.BETTER_AUTH_SECRET)).split(";")[0]!;
  key = (await issueKey(appEnv, "catalog-user", "Catalog CLI")).key;
  const credentials = await seal(appEnv, "tokens", { accessToken: "private-access", refreshToken: "private-refresh", accountId: "private-account", expiresAt: now + 3600_000 });
  await env.DB.prepare("INSERT INTO codex_connection (id, owner_identity, credentials, expires_at, updated_at) VALUES ('codex', ?, ?, ?, ?)")
    .bind(appEnv.OWNER_HACKCLUB_ID, credentials, now + 3600_000, now).run();
});

async function call(path: string, init: RequestInit = {}, overrides: Partial<AppEnv> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`http://localhost:8787${path}`, init), { ...appEnv, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function resolve(id: string, providers: unknown[] = [dynamicProvider]) {
  const ctx = createExecutionContext();
  try { return await resolveModel({ ...appEnv, PROVIDERS_JSON: JSON.stringify(providers) }, ctx, id); }
  finally { await waitOnExecutionContext(ctx); }
}
const keyHeaders = () => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
const catalogFetch = () => vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(discovered));

describe("shared model catalog routing", () => {
  it("serves a native and OpenAI-compatible catalog using the account default", async () => {
    const fetcher = catalogFetch();
    const response = await call("/v1/models?client_version=0.154.0", { headers: keyHeaders() });
    expect(response.status).toBe(200);
    const listing = await response.json<ModelListing>();
    expect(listing.default_model).toBe("preferred");
    expect(listing.object).toBe("list");
    expect(listing.data.map(({ id }) => id)).toEqual(["hidden", "preferred", "second"]);
    expect(listing.models.map(({ slug, supported_in_api, visibility }) => ({ slug, supported_in_api, visibility }))).toEqual([
      { slug: "hidden", supported_in_api: true, visibility: "hide" },
      { slug: "preferred", supported_in_api: true, visibility: "list" },
      { slug: "second", supported_in_api: true, visibility: "list" },
    ]);
    expect(listing.models[1]?.model_messages?.instructions_template).toBe("Native instructions");
    expect(JSON.stringify(listing)).not.toMatch(/private-access|private-refresh|private-account/);
    const browser = await call("/api/models", { headers: { cookie } });
    expect(await browser.json()).toEqual(listing);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not select a hidden-only account model as the default", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ models: [nativeModel("hidden", { visibility: "hide" })] }));
    const response = await call("/v1/models", { headers: keyHeaders() });
    expect((await response.json<ModelListing>()).default_model).toBeNull();
    await expect(resolve("codex")).rejects.toMatchObject({ status: 400 });
    await expect(resolve("codex", [staticProvider, dynamicProvider])).rejects.toMatchObject({ status: 400 });
  });

  it("requires the appropriate authenticated member for each catalog endpoint", async () => {
    const fetcher = catalogFetch();
    expect((await call("/v1/models")).status).toBe(401);
    expect((await call("/api/models")).status).toBe(401);
    expect((await call("/api/models", { headers: keyHeaders() })).status).toBe(401);
    expect((await call("/v1/models", { headers: { cookie } })).status).toBe(401);
    expect((await call("/api/models", { headers: { cookie } }, { ALLOWED_HACKCLUB_IDS: "" })).status).toBe(403);
    expect((await call("/v1/models", { headers: keyHeaders() }, { ALLOWED_HACKCLUB_IDS: "" })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("removes model access immediately when a member is suspended", async () => {
    catalogFetch();
    expect((await call("/api/models", { headers: { cookie } })).status).toBe(200);
    await env.DB.prepare("INSERT INTO proxy_member (identity_id, status, created_at, updated_at) VALUES (?, 'suspended', ?, ?)")
      .bind("ident!friend", Date.now(), Date.now()).run();
    expect((await call("/api/models", { headers: { cookie } })).status).toBe(403);
    expect((await call("/v1/models", { headers: keyHeaders() })).status).toBe(403);
  });

  it("keeps account controls available when ChatGPT is disconnected", async () => {
    const fetcher = catalogFetch();
    await env.DB.prepare("UPDATE codex_connection SET credentials = NULL").run();
    const response = await call("/api/me", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { name: "Catalog Friend" }, keys: [{ name: "Catalog CLI" }], models: [], defaultModel: null,
      modelCatalogStatus: "unavailable", modelCatalogError: "The owner needs to connect ChatGPT in the dashboard.",
    });
    expect((await call("/v1/models", { headers: keyHeaders() })).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the same real default in the member dashboard", async () => {
    catalogFetch();
    const response = await call("/api/me", { headers: { cookie } });
    expect(await response.json()).toMatchObject({ models: [{ id: "hidden" }, { id: "preferred" }, { id: "second" }], defaultModel: "preferred", modelCatalogStatus: "ready" });
  });

  it("resolves discovered IDs and the old codex alias to the real account models", async () => {
    const fetcher = catalogFetch();
    expect(await resolve("second")).toMatchObject({ id: "second", upstreamModel: "second", config: { protocol: "codex" } });
    expect(await resolve("codex")).toMatchObject({ id: "preferred", upstreamModel: "preferred" });
    expect(await resolve("hidden")).toMatchObject({ id: "hidden", upstreamModel: "hidden" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(resolve("made-up-model")).rejects.toMatchObject({ status: 400, message: "Unknown model. Use GET /v1/models to list available models." });
  });

  it("rejects unknown generation models before opening inference", async () => {
    const fetcher = catalogFetch();
    const response = await call("/v1/responses", { method: "POST", headers: keyHeaders(), body: JSON.stringify({ model: "does-not-exist", input: "hello" }) });
    expect(response.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.154.0");
  });

  it("preserves configured static providers and aliases without requiring ChatGPT discovery", async () => {
    const fetcher = catalogFetch();
    await env.DB.prepare("UPDATE codex_connection SET credentials = NULL").run();
    expect(await resolve("other", [staticProvider, dynamicProvider])).toMatchObject({ id: "other", upstreamModel: "upstream-other", config: { id: "other" } });
    expect(await resolve("codex", [{ id: "codex", protocol: "codex", models: { codex: "configured-model" } }])).toMatchObject({ id: "codex", upstreamModel: "configured-model" });
    const response = await call("/v1/models", { headers: keyHeaders() }, { PROVIDERS_JSON: JSON.stringify([staticProvider]) });
    expect(await response.json()).toEqual({ object: "list", data: [{ id: "other", object: "model", created: 0, owned_by: "other" }], models: [], default_model: "other" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lists static providers alongside discovered subscription models", async () => {
    catalogFetch();
    const ctx = createExecutionContext();
    const listing = await modelListing({ ...appEnv, PROVIDERS_JSON: JSON.stringify([staticProvider, dynamicProvider]) }, ctx);
    await waitOnExecutionContext(ctx);
    expect(listing.data.map(({ id }) => id)).toEqual(["other", "hidden", "preferred", "second"]);
    expect(listing.default_model).toBe("preferred");
  });

  it.each([false, true])("rejects aliases shadowing discovered models regardless of provider order (dynamic first: %s)", async (dynamicFirst) => {
    catalogFetch();
    const conflicting = { ...staticProvider, models: { preferred: "different-model" } };
    const response = await call("/v1/models", { headers: keyHeaders() }, {
      PROVIDERS_JSON: JSON.stringify(dynamicFirst ? [dynamicProvider, conflicting] : [conflicting, dynamicProvider]),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "configuration_error" } });
  });
});
