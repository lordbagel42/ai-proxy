import { z } from "zod";
import { ApiError } from "../core/errors";
import { object, string } from "../core/input";
import { readSSE } from "../core/sse";
import type { Event, GenerationRequest, JsonObject, Part } from "../core/types";
import { responsesBody, responsesEvents } from "./responses";

const apiDefinition = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  protocol: z.enum(["anthropic", "openai-chat", "openai-responses"]),
  baseUrl: z.url(),
  credential: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  auth: z.enum(["bearer", "x-api-key"]).default("bearer"),
  models: z.record(z.string().min(1), z.string().min(1)),
}).strict();
const definition = z.union([apiDefinition, z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), protocol: z.literal("codex"),
  models: z.record(z.string().min(1), z.string().min(1)),
}).strict()]);
export type ProviderDefinition = z.infer<typeof definition>;
export interface Provider {
  open(request: GenerationRequest, upstreamModel: string, signal: AbortSignal): Promise<AsyncIterable<Event>>;
}

export function configuredProviders(json: string): ProviderDefinition[] {
  try {
    const definitions = z.array(definition).parse(JSON.parse(json));
    const ids = new Set<string>(); const models = new Set<string>();
    for (const d of definitions) {
      if (d.protocol !== "codex") {
        const url = new URL(d.baseUrl);
        if (url.username || url.password || url.search || url.hash) throw new Error("Invalid provider URL");
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("HTTPS required");
      }
      if (ids.has(d.id) || !Object.keys(d.models).length) throw new Error("Invalid provider ID or models");
      ids.add(d.id);
      for (const model of Object.keys(d.models)) {
        if (models.has(model)) throw new Error("Duplicate model alias");
        models.add(model);
      }
    }
    return definitions;
  } catch { throw new ApiError(503, "Provider configuration is invalid.", "configuration_error"); }
}

function anthropicPart(part: Part): JsonObject {
  switch (part.type) {
    case "text": return { type: "text", text: part.text };
    case "call": return { type: "tool_use", id: part.id, name: part.name, input: JSON.parse(part.arguments) };
    case "result": return { type: "tool_result", tool_use_id: part.id, content: part.content, is_error: part.isError };
    case "image": {
      const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(part.url);
      if (part.url.startsWith("data:") && !match) throw new ApiError(400, "Unsupported image data URL.");
      return { type: "image", source: match ? { type: "base64", media_type: match[1], data: match[2] } : { type: "url", url: part.url } };
    }
  }
}

export function anthropicBody(r: GenerationRequest, model: string): JsonObject {
  let toolChoice: JsonObject | undefined;
  if (r.toolChoice) toolChoice = typeof r.toolChoice === "object" ? { type: "tool", name: r.toolChoice.name }
    : { type: r.toolChoice === "required" ? "any" : r.toolChoice };
  if (r.parallelTools === false && r.tools.length && r.toolChoice !== "none") {
    toolChoice = { ...(toolChoice ?? { type: "auto" }), disable_parallel_tool_use: true };
  }
  return {
    model, stream: true, max_tokens: r.maxTokens, system: r.system || undefined,
    messages: r.messages.map((m) => ({ role: m.role, content: m.content.map(anthropicPart) })),
    tools: r.tools.length ? r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) : undefined,
    tool_choice: toolChoice, temperature: r.temperature, top_p: r.topP, stop_sequences: r.stop,
  };
}

export function chatBody(r: GenerationRequest, model: string): JsonObject {
  const messages: JsonObject[] = [];
  if (r.system) messages.push({ role: "system", content: r.system });
  for (const m of r.messages) {
    // Keep tool results before any following user content, preserving conversation order.
    for (const p of m.content) if (p.type === "result") messages.push({ role: "tool", tool_call_id: p.id, content: p.content });
    const parts = m.content.flatMap((p): JsonObject[] => p.type === "text" ? [{ type: "text", text: p.text }]
      : p.type === "image" ? [{ type: "image_url", image_url: { url: p.url } }] : []);
    const calls = m.content.flatMap((p) => p.type === "call" ? [{ id: p.id, type: "function", function: { name: p.name, arguments: p.arguments } }] : []);
    if (parts.length || calls.length) messages.push({ role: m.role, content: parts.length ? parts : null, tool_calls: calls.length ? calls : undefined });
  }
  return {
    model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: r.maxTokens,
    temperature: r.temperature, top_p: r.topP, stop: r.stop,
    tools: r.tools.length ? r.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
    tool_choice: typeof r.toolChoice === "object" ? { type: "function", function: { name: r.toolChoice.name } } : r.toolChoice,
    parallel_tool_calls: r.parallelTools,
  };
}

function num(v: unknown) { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

export async function* anthropicEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Event> {
  let input = 0; let output = 0; let cached = 0;
  let reason: "stop" | "length" | "tool_calls" = "stop";
  let sawDelta = false;
  const active = new Set<number>();
  for await (const event of readSSE(body)) {
    const data = object(JSON.parse(event.data));
    if (data.type === "error") throw new ApiError(502, "The upstream provider returned a streaming error.", "api_error");
    if (data.type === "message_start") {
      const usage = object(object(data.message).usage);
      cached = num(usage.cache_read_input_tokens);
      input = num(usage.input_tokens) + cached + num(usage.cache_creation_input_tokens); output = num(usage.output_tokens);
      yield { type: "usage", input, output, cached };
    } else if (data.type === "content_block_start") {
      const block = object(data.content_block); const index = num(data.index);
      if (block.type === "text") {
        active.add(index); yield { type: "text_start", index };
        if (block.text) yield { type: "text_delta", index, text: string(block.text) };
      } else if (block.type === "tool_use") {
        active.add(index); yield { type: "tool_start", index, id: string(block.id), name: string(block.name) };
        if (block.input && Object.keys(object(block.input)).length) yield { type: "tool_delta", index, arguments: JSON.stringify(block.input) };
      } else if (!["thinking", "redacted_thinking"].includes(String(block.type))) {
        throw new ApiError(502, "The upstream returned an unsupported content block.", "api_error");
      }
    } else if (data.type === "content_block_delta") {
      const delta = object(data.delta); const index = num(data.index);
      if (delta.type === "text_delta") yield { type: "text_delta", index, text: string(delta.text) };
      if (delta.type === "input_json_delta") yield { type: "tool_delta", index, arguments: string(delta.partial_json) };
    } else if (data.type === "content_block_stop" && active.has(num(data.index))) {
      active.delete(num(data.index)); yield { type: "block_stop", index: num(data.index) };
    } else if (data.type === "message_delta") {
      const delta = object(data.delta);
      reason = delta.stop_reason === "max_tokens" ? "length" : delta.stop_reason === "tool_use" ? "tool_calls" : "stop";
      if (data.usage) output = num(object(data.usage).output_tokens);
      sawDelta = true;
      yield { type: "usage", input, output, cached };
    } else if (data.type === "message_stop") {
      if (!sawDelta || active.size) throw new ApiError(502, "The upstream stream was incomplete.", "api_error");
      yield { type: "finish", reason }; return;
    }
  }
  throw new ApiError(502, "The upstream stream ended before message_stop.", "api_error");
}

export async function* chatEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Event> {
  let textStarted = false;
  const calls = new Map<number, { id: string; name: string }>();
  let finish: "stop" | "length" | "tool_calls" | undefined;
  for await (const event of readSSE(body)) {
    if (event.data === "[DONE]") {
      if (!finish) throw new ApiError(502, "The upstream omitted its finish reason.", "api_error");
      if (textStarted) yield { type: "block_stop", index: 0 };
      for (const index of calls.keys()) yield { type: "block_stop", index: index + 1 };
      yield { type: "finish", reason: finish }; return;
    }
    const data = object(JSON.parse(event.data));
    if (data.error) throw new ApiError(502, "The upstream provider returned a streaming error.", "api_error");
    if (data.usage) {
      const usage = object(data.usage);
      yield { type: "usage", input: num(usage.prompt_tokens), output: num(usage.completion_tokens),
        cached: usage.prompt_tokens_details ? num(object(usage.prompt_tokens_details).cached_tokens) : 0 };
    }
    if (!Array.isArray(data.choices)) continue;
    for (const item of data.choices) {
      const choice = object(item);
      if (choice.index !== 0) continue;
      const delta = object(choice.delta ?? {});
      if (typeof delta.content === "string" && delta.content) {
        if (!textStarted) { textStarted = true; yield { type: "text_start", index: 0 }; }
        yield { type: "text_delta", index: 0, text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) for (const raw of delta.tool_calls) {
        const call = object(raw); const index = num(call.index); const fn = object(call.function ?? {});
        if (!calls.has(index)) {
          calls.set(index, { id: string(call.id), name: string(fn.name) });
          yield { type: "tool_start", index: index + 1, ...calls.get(index)! };
        }
        if (typeof fn.arguments === "string") yield { type: "tool_delta", index: index + 1, arguments: fn.arguments };
      }
      if (choice.finish_reason) {
        if (choice.finish_reason === "content_filter") throw new ApiError(502, "The upstream filtered this response.", "content_filter");
        finish = choice.finish_reason === "length" ? "length" : choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";
      }
    }
  }
  throw new ApiError(502, "The upstream stream ended before [DONE].", "api_error");
}

export function createProvider(config: z.infer<typeof apiDefinition>, credential: string): Provider {
  return {
    async open(request, upstreamModel, signal) {
      const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
      if (config.auth === "x-api-key") headers.set("x-api-key", credential);
      else headers.set("authorization", `Bearer ${credential}`);
      if (config.protocol === "anthropic") headers.set("anthropic-version", "2023-06-01");
      const path = config.protocol === "anthropic" ? "messages" : config.protocol === "openai-responses" ? "responses" : "chat/completions";
      const body = config.protocol === "anthropic" ? anthropicBody(request, upstreamModel)
        : config.protocol === "openai-responses" ? responsesBody(request, upstreamModel) : chatBody(request, upstreamModel);
      let response: Response;
      try {
        response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/${path}`, {
          method: "POST", headers, signal, redirect: "manual",
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ApiError(502, "The upstream provider could not be reached.", "api_error");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response.status === 429 ? 429 : 502,
          `Upstream ${config.id} returned HTTP ${response.status}.`, response.status === 429 ? "rate_limit_error" : "api_error",
          response.headers.get("retry-after") ?? undefined);
      }
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel(); throw new ApiError(502, "The upstream did not return an event stream.", "api_error");
      }
      return config.protocol === "anthropic" ? anthropicEvents(response.body)
        : config.protocol === "openai-responses" ? responsesEvents(response.body) : chatEvents(response.body);
    },
  };
}
