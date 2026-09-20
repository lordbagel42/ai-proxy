import { GenerationUsage, getAnalytics, personalUsage } from "./analytics";
import { apiUser, isOwner, issueKey, ownerUser, rawSessionUser, sameOrigin, sessionUser, takeGenerationRateLimit, takeRateLimit } from "./access";
import { acceptInvite, createInvite, getAdminOverview, revokeInvite, revokeMemberKeys, upsertMember } from "./admin";
import { membershipForUser } from "./membership";
import { completeBrowserConnection, connectionStatus, disconnectConnection, pollConnection, startBrowserConnection, startConnection } from "./codex/connection";
import { createAuth } from "./auth";
import { approveLogin, pollLogin, startLogin } from "./cli-auth";
import { ApiError, errorBody, publicError } from "./core/errors";
import { object, parseRequest, string } from "./core/input";
import { collect, encodeStream, formatCompletion, streamResponse } from "./core/output";
import { readJSON } from "./core/sse";
import type { Protocol } from "./core/types";
import type { AppEnv } from "./env";
import { createProvider } from "./providers";
import { createCodexProvider } from "./providers/codex";
import { modelListing, resolveModel, type ModelListing } from "./models";

function protocolFor(path: string): Protocol {
  return path.startsWith("/v1/messages") ? "anthropic" : path === "/v1/chat/completions" ? "chat" : "responses";
}

function pathIdentifier(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new ApiError(400, "Invalid resource identifier."); }
}

export async function route(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === "/health" && method === "GET") return Response.json({ status: "ok" });
  if (path.startsWith("/api/auth/")) return createAuth(env).handler(request);
  if (path === "/api/session" && method === "GET") {
    const user = await rawSessionUser(request, env);
    const membership = await membershipForUser(env, user.id);
    return Response.json({ user: { name: user.name, email: user.email }, isOwner: membership.isOwner, hasAccess: membership.status === "active" });
  }
  if (path === "/api/invites/accept" && method === "POST") {
    sameOrigin(request, env);
    const user = await rawSessionUser(request, env);
    await takeRateLimit(env, `invite-accept:${user.id}`, 10, 60);
    const body = object(await readJSON(request, 4096));
    await acceptInvite(env, user.id, string(body.token));
    return Response.json({ accepted: true });
  }
  if (path === "/api/admin/codex" || path.startsWith("/api/admin/codex/")) {
    if (method !== "GET") sameOrigin(request, env);
    const owner = await ownerUser(request, env);
    if (path === "/api/admin/codex" && method === "GET") return Response.json(await connectionStatus(env));
    if (path === "/api/admin/codex/browser/start" && method === "POST") {
      await takeRateLimit(env, `codex-start:${owner.id}`, 5, 60);
      const operation = startBrowserConnection(env);
      ctx.waitUntil(operation.then(() => {}, () => {}));
      return Response.json(await operation);
    }
    if (path === "/api/admin/codex/browser/complete" && method === "POST") {
      await takeRateLimit(env, `codex-complete:${owner.id}`, 10, 60);
      const body = object(await readJSON(request, 30_720));
      const operation = completeBrowserConnection(env, string(body.callbackUrl));
      ctx.waitUntil(operation.then(() => {}, () => {}));
      return Response.json(await operation);
    }
    if (path === "/api/admin/codex/start" && method === "POST") {
      await takeRateLimit(env, `codex-start:${owner.id}`, 5, 60);
      const operation = startConnection(env);
      ctx.waitUntil(operation.then(() => {}, () => {}));
      return Response.json(await operation);
    }
    if (path === "/api/admin/codex/poll" && method === "POST") {
      await takeRateLimit(env, `codex-poll:${owner.id}`, 30, 60);
      const operation = pollConnection(env);
      ctx.waitUntil(operation.then(() => {}, () => {}));
      return Response.json(await operation);
    }
    if (path === "/api/admin/codex" && method === "DELETE") {
      await disconnectConnection(env); return new Response(null, { status: 204 });
    }
    throw new ApiError(404, "Endpoint not found.", "not_found_error");
  }
  if (path.startsWith("/api/admin/")) {
    if (method !== "GET") sameOrigin(request, env);
    const owner = await ownerUser(request, env);
    if (method !== "GET") await takeRateLimit(env, `admin:${owner.id}`, 30, 60);
    if (path === "/api/admin/overview" && method === "GET") return Response.json(await getAdminOverview(env));
    if (path === "/api/admin/invites" && method === "POST") {
      await takeRateLimit(env, `invite-create:${owner.id}`, 10, 60);
      return Response.json(await createInvite(env, owner.id, object(await readJSON(request, 4096))), { status: 201 });
    }
    const inviteMatch = path.match(/^\/api\/admin\/invites\/([^/]+)$/);
    if (inviteMatch && method === "DELETE") {
      await revokeInvite(env, pathIdentifier(inviteMatch[1]!));
      return new Response(null, { status: 204 });
    }
    const memberMatch = path.match(/^\/api\/admin\/members\/([^/]+)(\/keys)?$/);
    if (memberMatch) {
      const identityId = pathIdentifier(memberMatch[1]!);
      if (method === "PATCH" && !memberMatch[2]) {
        await upsertMember(env, identityId, object(await readJSON(request, 4096)));
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE" && memberMatch[2]) {
        await revokeMemberKeys(env, identityId);
        return new Response(null, { status: 204 });
      }
    }
    throw new ApiError(404, "Endpoint not found.", "not_found_error");
  }
  if (path === "/api/cli/start" && method === "POST") return startLogin(request, env);
  if (path === "/api/cli/poll" && method === "POST") return pollLogin(request, env);
  if (path === "/api/cli/approve" && method === "POST") return approveLogin(request, env);
  if (path === "/api/cli/logout" && method === "POST") {
    const { keyId } = await apiUser(request, env);
    await env.DB.prepare("UPDATE api_key SET revoked_at = ? WHERE id = ?").bind(Date.now(), keyId).run();
    return new Response(null, { status: 204 });
  }
  if (path === "/api/analytics" && method === "GET") {
    const user = await sessionUser(request, env);
    return Response.json(await getAnalytics(env, user.id, new URL(request.url).searchParams.get("days")));
  }
  if (path === "/api/me" && method === "GET") {
    const user = await sessionUser(request, env);
    const keys = await env.DB.prepare("SELECT id, name, key_prefix, created_at, expires_at, last_used_at FROM api_key WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC").bind(user.id, Date.now()).all();
    const usage = await personalUsage(env, user.id);
    let listing: ModelListing | undefined; let modelCatalogError: string | undefined;
    try { listing = await modelListing(env, ctx, request.signal); }
    catch (error) { modelCatalogError = publicError(error).message; }
    return Response.json({ user: { name: user.name, email: user.email }, isOwner: await isOwner(env, user.id), keys: keys.results,
      models: listing?.data ?? [], defaultModel: listing?.default_model ?? null, modelCatalogStatus: listing ? "ready" : "unavailable", modelCatalogError,
      usage: usage ?? { requestsToday: 0, totalTokensToday: 0 }, baseUrl: `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/v1` });
  }
  if (path === "/api/models" && method === "GET") {
    await sessionUser(request, env);
    return Response.json(await modelListing(env, ctx, request.signal));
  }
  if (path === "/api/keys" && method === "POST") {
    sameOrigin(request, env); const user = await sessionUser(request, env);
    await takeRateLimit(env, `keys:${user.id}`, 10, 60);
    const body = object(await readJSON(request, 2048));
    const name = string(body.name).trim();
    if (!name || name.length > 80) throw new ApiError(400, "Key name must contain between 1 and 80 characters.");
    return Response.json(await issueKey(env, user.id, name), { status: 201 });
  }
  if (path.startsWith("/api/keys/") && method === "DELETE") {
    sameOrigin(request, env); const user = await sessionUser(request, env);
    const keyId = path.slice("/api/keys/".length);
    const result = await env.DB.prepare("UPDATE api_key SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(Date.now(), keyId, user.id).run();
    if (!result.meta.changes) throw new ApiError(404, "Key not found.");
    return new Response(null, { status: 204 });
  }
  if (path.startsWith("/v1/")) {
    const identity = await apiUser(request, env);
    if (path === "/v1/models" && method === "GET") return Response.json(await modelListing(env, ctx, request.signal));
    if (!["/v1/messages", "/v1/chat/completions", "/v1/responses"].includes(path) || method !== "POST") {
      throw new ApiError(404, "Supported endpoints: /v1/models, /v1/messages, /v1/chat/completions, /v1/responses.", "not_found_error");
    }
    const protocol = protocolFor(path);
    const generation = parseRequest(await readJSON(request), protocol);
    const { config, upstreamModel } = await resolveModel(env, ctx, generation.model, request.signal);
    const reasoningRequested = generation.reasoning && (
      (generation.reasoning.effort !== undefined && generation.reasoning.effort !== "none") ||
      // Codex sends summary:auto even when fallback model metadata says none.
      (generation.reasoning.summary !== undefined && !["none", "auto"].includes(generation.reasoning.summary)) ||
      generation.reasoning.context !== undefined
    );
    if (reasoningRequested && (config.protocol === "anthropic" || config.protocol === "openai-chat")) {
      throw new ApiError(400, "Reasoning controls require a Responses-compatible provider.");
    }
    let credential = "";
    if (config.protocol !== "codex") {
      const value: unknown = Reflect.get(env, config.credential);
      if (typeof value !== "string" || !value) throw new ApiError(503, "The upstream provider credential is not configured.", "configuration_error");
      credential = value;
    }
    await takeGenerationRateLimit(env, identity.userId);
    const controller = new AbortController();
    const lifecycle = AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]);
    const signal = AbortSignal.any([controller.signal, lifecycle]);
    const usage = new GenerationUsage(env, ctx, identity.userId, generation.model, config.id, protocol, lifecycle);
    try {
      const provider = config.protocol === "codex" ? createCodexProvider(env, ctx) : createProvider(config, credential);
      const events = usage.observe(await provider.open(generation, upstreamModel, signal));
      ctx.waitUntil(env.DB.prepare("UPDATE api_key SET last_used_at = ? WHERE id = ?").bind(Date.now(), identity.keyId).run().then(() => {}));
      if (generation.stream) return streamResponse(encodeStream(events, protocol, generation, () => usage.finish("error")), controller, {
        complete: () => usage.finish("success"), cancel: () => usage.finish("cancelled"), error: () => usage.finish("error"),
      });
      const completion = await collect(events, generation);
      const response = Response.json(formatCompletion(completion, protocol, generation));
      usage.finish("success");
      controller.abort();
      return response;
    } catch (error) { usage.finish("error"); controller.abort(); throw error; }
  }
  if (path.startsWith("/api/")) throw new ApiError(404, "Endpoint not found.", "not_found_error");
  if (method !== "GET" && method !== "HEAD") throw new ApiError(405, "Method not allowed.");
  const url = new URL(request.url);
  if (path === "/" || path === "/connect" || path === "/invite" || path === "/invite/") url.pathname = "/index.html";
  if (path === "/admin" || path === "/admin/") url.pathname = "/admin.html";
  return env.ASSETS.fetch(new Request(url, request));
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      if (env.MAINTENANCE_MODE === "true") {
        response = new URL(request.url).pathname === "/health" && request.method === "GET"
          ? Response.json({ status: "ok", serving: false })
          : Response.json({ error: { message: "Gateway is paused for migration.", type: "maintenance_error" } },
            { status: 503, headers: { "retry-after": "60" } });
      } else response = await route(request, env, ctx);
    }
    catch (error) {
      const failure = publicError(error);
      if (failure.status >= 500) console.error(JSON.stringify({ requestId, status: failure.status, code: failure.code }));
      response = Response.json(errorBody(failure, protocolFor(new URL(request.url).pathname)), { status: failure.status,
        headers: failure.retryAfter ? { "retry-after": failure.retryAfter } : undefined });
    }
    response = new Response(response.body, response);
    response.headers.set("x-request-id", requestId);
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("cache-control", "no-store");
    response.headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return response;
  },
  async scheduled(_event: ScheduledController, env: AppEnv) {
    if (env.MAINTENANCE_MODE === "true") return;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cli_login WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM quota WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM rate_limit WHERE last_request < ?").bind(now - 86_400_000),
      env.DB.prepare("DELETE FROM codex_request WHERE expires_at < ?").bind(now),
    ]);
  },
} satisfies ExportedHandler<AppEnv>;
