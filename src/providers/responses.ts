import { ApiError } from "../core/errors";
import { readSSE } from "../core/sse";
import type { Event, GenerationRequest, JsonObject, MessagePhase } from "../core/types";

/** Responses history is an ordered list: tool items must not be moved around messages. */
export function responsesBody(request: GenerationRequest, model: string): JsonObject {
  if (request.stop?.length) throw new ApiError(400, "This provider does not support stop sequences.");
  const input: JsonObject[] = [];
  for (const message of request.messages) {
    let content: JsonObject[] = [];
    const flush = () => {
      if (content.length) input.push({ role: message.role, content,
        ...(message.role === "assistant" && message.phase !== undefined ? { phase: message.phase } : {}) });
      content = [];
    };
    for (const part of message.content) {
      if (part.type === "text") content.push({ type: "input_text", text: part.text });
      else if (part.type === "image") content.push({ type: "input_image", image_url: part.url, detail: "auto" });
      else {
        flush();
        input.push(part.type === "call"
          ? { type: "function_call", call_id: part.id, name: part.name, arguments: part.arguments }
          : { type: "function_call_output", call_id: part.id, output: part.content });
      }
    }
    flush();
  }
  return {
    model, input, instructions: request.system, store: false, stream: true,
    max_output_tokens: request.maxTokens, temperature: request.temperature, top_p: request.topP,
    tools: request.tools.map((tool) => ({ type: "function", name: tool.name,
      description: tool.description, parameters: tool.parameters, strict: false })),
    tool_choice: typeof request.toolChoice === "object" ? { type: "function", name: request.toolChoice.name } : request.toolChoice,
    parallel_tool_calls: request.parallelTools,
    reasoning: request.reasoning,
  };
}

function invalid(message = "The upstream returned an invalid Responses event."): never {
  throw new ApiError(502, message, "api_error");
}
function record(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as JsonObject;
}
function text(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function identifier(value: unknown): string { const result = text(value); if (!result) invalid(); return result; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); return value as number; }
function phase(value: unknown): MessagePhase | undefined {
  if (value === undefined || value === null || value === "commentary" || value === "final_answer") return value;
  invalid("The upstream returned an invalid assistant message phase.");
}
function argumentsObject(value: string): void {
  try { record(JSON.parse(value)); } catch { invalid("The upstream returned invalid tool arguments."); }
}

interface TextPart { index: number; text: string; textDone: boolean; done: boolean }
type OutputItem = { id: string; done: boolean } & (
  | { type: "message"; parts: Map<number, TextPart>; phase?: MessagePhase }
  | { type: "function_call"; index: number; callId: string; name: string; arguments: string; argumentsDone: boolean }
  | { type: "reasoning" }
);

/** Decode only text and function tools; hosted tools, refusals and other modalities fail explicitly. */
export async function* responsesEvents(body: ReadableStream<Uint8Array>, options: { allowEmptyTerminalOutput?: boolean } = {}): AsyncGenerator<Event> {
  const items = new Map<number, OutputItem>();
  let responseId: string | undefined;
  let nextBlock = 0;
  let lastSequence = -1;
  let hasTools = false;
  const itemFor = (data: JsonObject): OutputItem => {
    const item = items.get(integer(data.output_index));
    if (!item || item.done || item.id !== data.item_id) invalid("The upstream sent an out-of-order Responses event.");
    return item;
  };
  const partFor = (data: JsonObject): TextPart => {
    const item = itemFor(data);
    if (item.type !== "message") invalid();
    const part = item.parts.get(integer(data.content_index));
    if (!part || part.done) invalid("The upstream sent an out-of-order text event.");
    return part;
  };
  const validateSnapshot = (item: OutputItem, snapshot: JsonObject) => {
    if (snapshot.id !== item.id || snapshot.type !== item.type) invalid();
    if (item.type === "function_call") {
      if (snapshot.call_id !== item.callId || snapshot.name !== item.name || snapshot.arguments !== item.arguments) invalid();
    } else if (item.type === "message") {
      if (snapshot.role !== "assistant" || !Array.isArray(snapshot.content) || snapshot.content.length !== item.parts.size) invalid();
      if (snapshot.phase !== undefined && phase(snapshot.phase) !== item.phase) invalid();
      snapshot.content.forEach((raw, index) => {
        const part = record(raw);
        if (part.type !== "output_text" || part.text !== item.parts.get(index)?.text) invalid();
      });
    }
  };
  for await (const frame of readSSE(body)) {
    let data: JsonObject;
    try { data = record(JSON.parse(frame.data)); } catch { invalid("The upstream returned malformed Responses data."); }
    const type = text(data.type);
    // Codex interleaves transport/account metadata with Responses events. These
    // are not content and may arrive before response.created without its sequence.
    if (["codex.response.metadata", "response.metadata", "responsesapi.websocket_timing"].includes(type)) continue;
    if (data.sequence_number !== undefined) {
      const sequence = integer(data.sequence_number);
      if (sequence <= lastSequence) invalid("The upstream reused or reordered an event sequence.");
      lastSequence = sequence;
    }
    if (type === "error" || type === "response.failed") invalid("The upstream provider returned a streaming error.");
    if (type === "response.created") {
      if (responseId) invalid();
      responseId = identifier(record(data.response).id);
      continue;
    }
    if (!responseId) invalid("The upstream omitted response.created.");
    if (type === "response.in_progress" || type === "response.queued") {
      if (record(data.response).id !== responseId) invalid();
    } else if (type === "response.output_item.added") {
      const outputIndex = integer(data.output_index);
      if (outputIndex !== items.size) invalid("The upstream reordered its output items.");
      const raw = record(data.item); const id = identifier(raw.id);
      if (Array.from(items.values()).some((item) => item.id === id)) invalid();
      if (raw.type === "message") {
        if (raw.role !== "assistant" || !Array.isArray(raw.content) || raw.content.length) invalid();
        items.set(outputIndex, { type: "message", id, done: false, parts: new Map(), phase: phase(raw.phase) });
      } else if (raw.type === "function_call") {
        const item: OutputItem = { type: "function_call", id, done: false, index: nextBlock++,
          callId: identifier(raw.call_id), name: identifier(raw.name), arguments: text(raw.arguments), argumentsDone: false };
        items.set(outputIndex, item); hasTools = true;
        yield { type: "tool_start", index: item.index, id: item.callId, name: item.name };
        if (item.arguments) yield { type: "tool_delta", index: item.index, arguments: item.arguments };
      } else if (raw.type === "reasoning") items.set(outputIndex, { type: "reasoning", id, done: false });
      else invalid("The upstream returned an unsupported Responses output item.");
    } else if (type === "response.content_part.added") {
      const item = itemFor(data); const contentIndex = integer(data.content_index); const raw = record(data.part);
      if (item.type !== "message" || contentIndex !== item.parts.size) invalid();
      if (raw.type !== "output_text") invalid("The upstream returned unsupported Responses content.");
      const part = { index: nextBlock++, text: text(raw.text), textDone: false, done: false };
      item.parts.set(contentIndex, part);
      yield { type: "text_start", index: part.index, ...(item.phase !== undefined ? { phase: item.phase } : {}) };
      if (part.text) yield { type: "text_delta", index: part.index, text: part.text };
    } else if (type === "response.output_text.delta") {
      const part = partFor(data);
      if (part.textDone) invalid();
      const delta = text(data.delta); part.text += delta;
      yield { type: "text_delta", index: part.index, text: delta };
    } else if (type === "response.output_text.done") {
      const part = partFor(data);
      if (part.textDone || data.text !== part.text) invalid();
      part.textDone = true;
    } else if (type === "response.content_part.done") {
      const part = partFor(data); const raw = record(data.part);
      if (!part.textDone || raw.type !== "output_text" || raw.text !== part.text) invalid();
      part.done = true;
    } else if (type === "response.function_call_arguments.delta") {
      const item = itemFor(data);
      if (item.type !== "function_call" || item.argumentsDone) invalid();
      const delta = text(data.delta); item.arguments += delta;
      yield { type: "tool_delta", index: item.index, arguments: delta };
    } else if (type === "response.function_call_arguments.done") {
      const item = itemFor(data);
      if (item.type !== "function_call" || item.argumentsDone || data.arguments !== item.arguments) invalid();
      if (data.name !== undefined && data.name !== item.name) invalid();
      argumentsObject(item.arguments); item.argumentsDone = true;
    } else if (type === "response.output_item.done") {
      const item = items.get(integer(data.output_index));
      if (!item || item.done) invalid();
      const snapshot = record(data.item);
      if (item.type === "message" && snapshot.phase !== undefined) {
        const finalPhase = phase(snapshot.phase);
        if (item.phase !== undefined && item.phase !== null && finalPhase !== item.phase) invalid();
        item.phase = finalPhase;
      }
      validateSnapshot(item, snapshot);
      if (item.type === "message" && Array.from(item.parts.values()).some((part) => !part.done)) invalid();
      if (item.type === "message") {
        // The finalized item may be the first event carrying its phase. Keep
        // streaming text immediately, but close it only once that metadata exists.
        for (const part of item.parts.values()) yield { type: "block_stop", index: part.index,
          ...(item.phase !== undefined ? { phase: item.phase } : {}) };
      }
      if (item.type === "function_call") {
        if (!item.argumentsDone) invalid();
        yield { type: "block_stop", index: item.index };
      }
      item.done = true;
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = record(data.response);
      if (response.id !== responseId || response.status !== type.slice("response.".length)) invalid();
      if (Array.from(items.values()).some((item) => !item.done)) invalid("The upstream left a Responses output item open.");
      if (!Array.isArray(response.output)) invalid();
      // Codex may omit repeated output snapshots at completion by sending [].
      // Every item has already been finalized and validated above; a supplied
      // nonempty snapshot must still match that exact ordered output.
      if (!options.allowEmptyTerminalOutput || response.output.length > 0) {
        if (response.output.length !== items.size) invalid();
        response.output.forEach((raw, index) => validateSnapshot(items.get(index)!, record(raw)));
      }
      if (type === "response.incomplete" && record(response.incomplete_details).reason !== "max_output_tokens") {
        invalid("The upstream could not complete this response.");
      }
      if (response.usage) {
        const usage = record(response.usage);
        yield { type: "usage", input: integer(usage.input_tokens), output: integer(usage.output_tokens),
          cached: usage.input_tokens_details ? integer(record(usage.input_tokens_details).cached_tokens ?? 0) : 0 };
      }
      yield { type: "finish", reason: type === "response.incomplete" ? "length" : hasTools ? "tool_calls" : "stop" };
      return;
    } else if (type.startsWith("response.reasoning_summary_") || type.startsWith("response.reasoning_text.")) {
      if (itemFor(data).type !== "reasoning") invalid();
    } else if (type === "response.output_text.annotation.added") {
      partFor(data); // The normalized protocol has no annotation field.
    } else invalid("The upstream returned an unsupported Responses event.");
    if (items.size > 512 || nextBlock > 512) invalid("The upstream response exceeded the size limit.");
  }
  invalid("The upstream stream ended before response.completed or response.incomplete.");
}
