import { ApiError, errorBody, publicError } from "./errors";
import { sse } from "./sse";
import type { Completion, Event, GenerationRequest, JsonObject, Protocol } from "./types";

function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }

class Accumulator {
  result: Completion;
  indexes = new Map<number, number>();
  stopped = new Set<number>();
  finished = false;
  size = 0;
  constructor(model: string) {
    this.result = { id: id("resp"), model, created: Math.floor(Date.now() / 1000), blocks: [], usage: { input: 0, output: 0, cached: 0 }, reason: "stop" };
  }
  apply(event: Event) {
    if (this.finished) throw new ApiError(502, "Upstream sent data after completion.", "api_error");
    if (event.type === "usage") this.result.usage = { input: event.input, output: event.output, cached: event.cached ?? 0 };
    else if (event.type === "finish") {
      this.finished = true; this.result.reason = event.reason;
      if (this.stopped.size !== this.indexes.size) throw new ApiError(502, "Upstream left a content block open.", "api_error");
    } else {
      if (event.type === "text_start" || event.type === "tool_start") {
        if (this.indexes.has(event.index)) throw new ApiError(502, "Upstream reused a content block index.", "api_error");
        this.indexes.set(event.index, this.result.blocks.length);
        this.result.blocks.push(event.type === "text_start" ? { type: "text", text: "" } : { type: "tool", id: event.id, name: event.name, arguments: "" });
      } else {
        const index = this.indexes.get(event.index);
        const block = index === undefined ? undefined : this.result.blocks[index];
        if (!block || this.stopped.has(event.index)) throw new ApiError(502, "Upstream sent an invalid content block delta.", "api_error");
        if (event.type === "text_delta" && block.type === "text") { block.text += event.text; this.size += event.text.length; }
        else if (event.type === "tool_delta" && block.type === "tool") { block.arguments += event.arguments; this.size += event.arguments.length; }
        else if (event.type === "block_stop") {
          this.stopped.add(event.index);
          if (block.type === "tool") {
            block.arguments ||= "{}";
            try {
              const args: unknown = JSON.parse(block.arguments);
              if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
            } catch { throw new ApiError(502, "The upstream returned invalid tool arguments.", "api_error"); }
          }
        } else throw new ApiError(502, "Upstream sent a mismatched content delta.", "api_error");
      }
    }
    if (this.size > 2_097_152 || this.result.blocks.length > 512) throw new ApiError(502, "The upstream response exceeded the size limit.", "api_error");
  }
}

function responseUsage(c: Completion) {
  return { input_tokens: c.usage.input, input_tokens_details: { cached_tokens: c.usage.cached }, output_tokens: c.usage.output,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: c.usage.input + c.usage.output };
}
function customInput(args: string): string {
  const parsed: unknown = JSON.parse(args);
  if (!parsed || typeof parsed !== "object" || !("input" in parsed) || typeof parsed.input !== "string") {
    throw new ApiError(502, "The upstream returned invalid custom tool input.", "api_error");
  }
  return parsed.input;
}

function responseItem(c: Completion, index: number, request: GenerationRequest, complete: boolean): JsonObject {
  const block = c.blocks[index]!;
  if (block.type === "text") return {
    type: "message", id: `msg_${c.id}_${index}`, role: "assistant", status: complete ? "completed" : "in_progress",
    content: complete ? [{ type: "output_text", text: block.text, annotations: [], logprobs: [] }] : [],
  };
  const tool = request.tools.find((t) => t.name === block.name);
  const name = tool?.clientName ?? block.name;
  const namespace = tool?.namespace;
  if (tool?.custom) return {
    type: "custom_tool_call", id: `ct_${c.id}_${index}`, call_id: block.id, name, ...(namespace ? { namespace } : {}),
    input: complete ? customInput(block.arguments) : "", status: complete ? "completed" : "in_progress",
  };
  return { type: "function_call", id: `fc_${c.id}_${index}`, call_id: block.id, name, ...(namespace ? { namespace } : {}),
    arguments: complete ? block.arguments : "", status: complete ? "completed" : "in_progress" };
}

function responseObject(c: Completion, request: GenerationRequest, status: string): JsonObject {
  return {
    id: c.id, object: "response", created_at: c.created, completed_at: status === "in_progress" ? null : Math.floor(Date.now() / 1000),
    status, model: c.model, output: status === "in_progress" ? [] : c.blocks.map((_, i) => responseItem(c, i, request, true)),
    error: null, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    usage: status === "in_progress" ? null : responseUsage(c),
    parallel_tool_calls: request.parallelTools ?? true, tool_choice: "auto", tools: [], store: false,
  };
}

export function formatCompletion(c: Completion, protocol: Protocol, request: GenerationRequest): JsonObject {
  if (protocol === "responses") return responseObject(c, request, c.reason === "length" ? "incomplete" : "completed");
  if (protocol === "anthropic") return {
    id: c.id.replace("resp_", "msg_"), type: "message", role: "assistant", model: c.model,
    content: c.blocks.map((b) => b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name, input: JSON.parse(b.arguments) }),
    stop_reason: c.reason === "length" ? "max_tokens" : c.reason === "tool_calls" ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: c.usage.input - c.usage.cached, cache_read_input_tokens: c.usage.cached, output_tokens: c.usage.output },
  };
  const calls = c.blocks.flatMap((b) => b.type === "tool" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: b.arguments } }] : []);
  return {
    id: c.id.replace("resp_", "chatcmpl_"), object: "chat.completion", created: c.created, model: c.model,
    choices: [{ index: 0, finish_reason: c.reason, message: { role: "assistant", content: c.blocks.filter((b) => b.type === "text").map((b) => b.text).join("") || null,
      ...(calls.length ? { tool_calls: calls } : {}) } }],
    usage: { prompt_tokens: c.usage.input, completion_tokens: c.usage.output, total_tokens: c.usage.input + c.usage.output,
      prompt_tokens_details: { cached_tokens: c.usage.cached } },
  };
}

export async function collect(events: AsyncIterable<Event>, request: GenerationRequest): Promise<Completion> {
  const state = new Accumulator(request.model);
  for await (const event of events) state.apply(event);
  if (!state.finished) throw new ApiError(502, "The upstream stream was incomplete.", "api_error");
  return state.result;
}

export async function* encodeStream(events: AsyncIterable<Event>, protocol: Protocol, request: GenerationRequest, onError?: () => void): AsyncGenerator<string> {
  const state = new Accumulator(request.model); const c = state.result;
  let sequence = 0; let toolIndex = 0;
  const toolIndexes = new Map<number, number>();
  const responseEvent = (type: string, data: JsonObject) => sse({ type, sequence_number: sequence++, ...data }, type);
  const anthropicEvent = (type: string, data: JsonObject) => sse({ type, ...data }, type);
  const chatEvent = (delta: JsonObject, reason: string | null = null) => sse({
    id: c.id.replace("resp_", "chatcmpl_"), object: "chat.completion.chunk", created: c.created, model: c.model,
    choices: [{ index: 0, delta, finish_reason: reason }],
  });
  if (protocol === "responses") {
    yield responseEvent("response.created", { response: responseObject(c, request, "in_progress") });
    yield responseEvent("response.in_progress", { response: responseObject(c, request, "in_progress") });
  } else if (protocol === "chat") yield chatEvent({ role: "assistant", content: "" });
  else yield anthropicEvent("message_start", { message: { id: c.id.replace("resp_", "msg_"), type: "message", role: "assistant", model: c.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  try {
    for await (const event of events) {
      state.apply(event);
      if (event.type === "usage") continue;
      if (event.type === "finish") {
        if (protocol === "responses") {
          const status = c.reason === "length" ? "incomplete" : "completed";
          yield responseEvent(`response.${status}`, { response: responseObject(c, request, status) });
        } else if (protocol === "chat") {
          yield chatEvent({}, c.reason);
          yield sse({ id: c.id.replace("resp_", "chatcmpl_"), object: "chat.completion.chunk", created: c.created, model: c.model, choices: [],
            usage: { prompt_tokens: c.usage.input, completion_tokens: c.usage.output, total_tokens: c.usage.input + c.usage.output } });
          yield sse("[DONE]");
        } else {
          yield anthropicEvent("message_delta", { delta: { stop_reason: c.reason === "length" ? "max_tokens" : c.reason === "tool_calls" ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { input_tokens: c.usage.input - c.usage.cached, cache_read_input_tokens: c.usage.cached, output_tokens: c.usage.output } });
          yield anthropicEvent("message_stop", {});
        }
        continue;
      }
      const index = state.indexes.get(event.index)!;
      const block = c.blocks[index]!;
      if (protocol === "responses") {
        const item = responseItem(c, index, request, event.type === "block_stop");
        const item_id = item.id;
        if (event.type === "text_start" || event.type === "tool_start") {
          yield responseEvent("response.output_item.added", { output_index: index, item });
          if (event.type === "text_start") yield responseEvent("response.content_part.added", { item_id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } });
        } else if (event.type === "text_delta") yield responseEvent("response.output_text.delta", { item_id, output_index: index, content_index: 0, delta: event.text, logprobs: [] });
        else if (event.type === "tool_delta" && item.type !== "custom_tool_call") yield responseEvent("response.function_call_arguments.delta", { item_id, output_index: index, delta: event.arguments });
        else if (event.type === "block_stop") {
          if (block.type === "text") {
            yield responseEvent("response.output_text.done", { item_id, output_index: index, content_index: 0, text: block.text, logprobs: [] });
            yield responseEvent("response.content_part.done", { item_id, output_index: index, content_index: 0, part: { type: "output_text", text: block.text, annotations: [], logprobs: [] } });
          } else if (item.type === "custom_tool_call") {
            yield responseEvent("response.custom_tool_call_input.delta", { item_id, output_index: index, delta: item.input });
            yield responseEvent("response.custom_tool_call_input.done", { item_id, output_index: index, input: item.input });
          } else yield responseEvent("response.function_call_arguments.done", { item_id, output_index: index, name: item.name, ...(item.namespace ? { namespace: item.namespace } : {}), arguments: block.arguments });
          yield responseEvent("response.output_item.done", { output_index: index, item });
        }
      } else if (protocol === "anthropic") {
        if (event.type === "text_start") yield anthropicEvent("content_block_start", { index, content_block: { type: "text", text: "" } });
        if (event.type === "tool_start") yield anthropicEvent("content_block_start", { index, content_block: { type: "tool_use", id: event.id, name: event.name, input: {} } });
        if (event.type === "text_delta") yield anthropicEvent("content_block_delta", { index, delta: { type: "text_delta", text: event.text } });
        if (event.type === "tool_delta") yield anthropicEvent("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: event.arguments } });
        if (event.type === "block_stop") yield anthropicEvent("content_block_stop", { index });
      } else {
        if (event.type === "text_delta") yield chatEvent({ content: event.text });
        if (event.type === "tool_start") {
          toolIndexes.set(index, toolIndex++);
          yield chatEvent({ tool_calls: [{ index: toolIndexes.get(index), id: event.id, type: "function", function: { name: event.name, arguments: "" } }] });
        }
        if (event.type === "tool_delta") yield chatEvent({ tool_calls: [{ index: toolIndexes.get(index), function: { arguments: event.arguments } }] });
      }
    }
    if (!state.finished) throw new ApiError(502, "The upstream stream was incomplete.", "api_error");
  } catch (error) {
    onError?.();
    const e = publicError(error);
    if (protocol === "responses") yield responseEvent("response.failed", {
      response: { id: c.id, object: "response", created_at: c.created, model: c.model, status: "failed", output: [],
        error: { code: e.code, message: e.message }, usage: responseUsage(c) },
    });
    else yield sse(errorBody(e, protocol), protocol === "anthropic" ? "error" : undefined);
  }
}

export function streamResponse(source: AsyncGenerator<string>, abort: AbortController, lifecycle?: { complete(): void; cancel(): void; error(): void }): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await source.next();
        if (next.done) { lifecycle?.complete(); controller.close(); abort.abort(); }
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) { lifecycle?.error(); abort.abort(); controller.error(error); }
    },
    async cancel() { lifecycle?.cancel(); abort.abort(); await source.return(undefined).catch(() => {}); },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
