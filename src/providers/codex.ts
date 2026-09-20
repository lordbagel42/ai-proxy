import { CLIENT_USER_AGENT, codexRejection, codexStreamRejection } from "../codex/http";
import { acquireCodexSlot, codexCredentials, markConnectionRejected } from "../codex/connection";
import { ApiError } from "../core/errors";
import type { Event, GenerationRequest, JsonObject } from "../core/types";
import type { AppEnv } from "../env";
import type { Provider } from "./index";
import { responsesBody, responsesEvents } from "./responses";

function codexBody(request: GenerationRequest, model: string): JsonObject {
  if (request.temperature !== undefined || request.topP !== undefined) {
    throw new ApiError(400, "Codex subscription requests do not support sampling controls.");
  }
  const body = responsesBody(request, model);
  // Codex's subscription endpoint does not accept a caller-specified token cap.
  delete body.max_output_tokens;
  delete body.temperature;
  delete body.top_p;
  body.tool_choice ??= "auto";
  body.parallel_tool_calls ??= true;
  return body;
}

function releasing(events: AsyncIterable<Event>, release: () => Promise<void>, signal: AbortSignal, ctx: ExecutionContext): AsyncIterable<Event> {
  const iterator = events[Symbol.asyncIterator]();
  const onAbort = () => ctx.waitUntil(release());
  const cleanup = async () => { signal.removeEventListener("abort", onAbort); await release(); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  // A custom iterator releases even if cancelled before the first next(). An
  // unstarted async generator would skip its finally block in that case.
  return { [Symbol.asyncIterator]() { return {
    async next() {
      try { const value = await iterator.next(); if (value.done) await cleanup(); return value; }
      catch (error) { await cleanup(); throw error; }
    },
    async return() {
      try { return await iterator.return?.() ?? { value: undefined, done: true as const }; }
      finally { await cleanup(); }
    },
  }; } };
}

export function createCodexProvider(env: AppEnv, ctx: ExecutionContext): Provider {
  const credentialsFor = async (rejected?: Awaited<ReturnType<typeof codexCredentials>>) => {
    const operation = codexCredentials(env, rejected);
    // Persist token rotation even if the client disconnects during authentication.
    ctx.waitUntil(operation.then(() => {}, () => {}));
    return operation;
  };
  return { async open(request, model, signal) {
    const body = JSON.stringify(codexBody(request, model));
    const releaseSlot = await acquireCodexSlot(env);
    const release = async () => {
      try { await releaseSlot(); }
      catch {
        // Retrying an idempotent cleanup must not turn a completed generation into
        // an API failure. The lease expires if the database remains unavailable.
        ctx.waitUntil(releaseSlot().catch(() => { console.error(JSON.stringify({ code: "codex_slot_cleanup_failed" })); }));
      }
    };
    try {
      let credentials = await credentialsFor();
      const send = () => fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST", redirect: "manual", signal,
        headers: { "content-type": "application/json", accept: "text/event-stream",
          originator: "codex_cli_rs", "user-agent": CLIENT_USER_AGENT,
          authorization: `Bearer ${credentials.tokens.accessToken}`, "ChatGPT-Account-ID": credentials.tokens.accountId }, body,
      });
      let response = await send();
      // Only retry an authentication rejection, before any generated content.
      if (response.status === 401) {
        await response.body?.cancel();
        credentials = await credentialsFor(credentials);
        response = await send();
      }
      if (!response.ok) {
        if (response.status === 401) {
          await response.body?.cancel();
          await markConnectionRejected(env, credentials.version);
          throw new ApiError(503, "ChatGPT needs to be reconnected by the owner.", "codex_reauthentication_required");
        }
        throw await codexRejection(response, signal, "responses");
      }
      const contentType = response.headers.get("content-type");
      const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
      // Codex can omit Content-Type on a successful SSE response. Still reject
      // explicit incompatible types, and validate every event and completion below.
      if (!response.body || (contentType !== null && mediaType !== "text/event-stream")) {
        const error = codexStreamRejection(response);
        await response.body?.cancel(); throw error;
      }
      return releasing(responsesEvents(response.body), release, signal, ctx);
    } catch (error) {
      await release();
      if (error instanceof ApiError || signal.aborted) throw error;
      throw new ApiError(502, "Codex could not be reached.", "api_error");
    }
  } };
}
