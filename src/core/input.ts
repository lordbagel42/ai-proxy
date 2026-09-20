import { z } from "zod";
import { createHash } from "node:crypto";
import { invalid } from "./errors";
import type { GenerationRequest, JsonObject, Message, Part, Protocol, Tool } from "./types";

export function object(value: unknown, label = "value"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as JsonObject;
}
export function string(value: unknown, label = "value"): string {
  if (typeof value !== "string") invalid(`${label} must be a string.`);
  return value;
}
export function array(value: unknown, label = "value"): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  return value;
}
function jsonArguments(value: unknown): string {
  const raw = string(value, "tool arguments");
  try { object(JSON.parse(raw), "tool arguments"); } catch { invalid("Tool arguments must contain a JSON object."); }
  return raw;
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  return array(value, "content").map((v) => {
    const p = object(v);
    if (!["text", "input_text", "output_text"].includes(String(p.type))) invalid(`Unsupported text content type: ${p.type}.`);
    return string(p.text, "text");
  }).join("\n");
}
function content(value: unknown): Part[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return array(value, "content").map((v): Part => {
    const p = object(v);
    if (["text", "input_text", "output_text"].includes(String(p.type))) return { type: "text", text: string(p.text) };
    if (p.type === "image_url" || p.type === "input_image") {
      const url = typeof p.image_url === "string" ? p.image_url : object(p.image_url).url;
      return { type: "image", url: string(url, "image_url") };
    }
    if (p.type === "image") {
      const source = object(p.source);
      if (source.type === "url") return { type: "image", url: string(source.url) };
      if (source.type === "base64") return { type: "image", url: `data:${string(source.media_type)};base64,${string(source.data)}` };
    }
    if (p.type === "tool_use") return { type: "call", id: string(p.id), name: string(p.name), arguments: JSON.stringify(object(p.input)) };
    if (p.type === "tool_result") return { type: "result", id: string(p.tool_use_id), content: textContent(p.content), isError: p.is_error === true };
    invalid(`Unsupported content type: ${p.type}.`);
  });
}

function tools(value: unknown, protocol: Protocol): Tool[] {
  if (value === undefined) return [];
  const parsed = array(value, "tools").flatMap((v): Tool[] => {
    const t = object(v);
    if (protocol === "responses" && t.type === "namespace") {
      const namespace = string(t.name);
      const nested = array(t.tools, "namespace tools");
      if (nested.some((v) => object(v).type === "namespace")) invalid("Nested tool namespaces are not supported.");
      return tools(nested, protocol).map((tool) => ({ ...tool, clientName: tool.name, namespace,
        name: namespaced(namespace, tool.name), description: [t.description, tool.description].filter(Boolean).join("\n") }));
    }
    if (protocol === "anthropic") {
      if (t.type && t.type !== "custom") invalid("Only client-defined tools are supported.");
      return [{ name: string(t.name), description: t.description as string | undefined, parameters: object(t.input_schema) }];
    }
    if (t.type === "custom" && protocol === "responses") {
      const format = t.format ? `\nThe input must follow this format: ${JSON.stringify(t.format)}` : "";
      return [{
        name: string(t.name), custom: true, description: `${t.description ?? ""}${format}`,
        parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
      }];
    }
    if (t.type !== "function") invalid(`Unsupported tool type: ${t.type}. Use client-side function tools.`);
    const f = protocol === "chat" ? object(t.function) : t;
    return [{ name: string(f.name), description: f.description as string | undefined, parameters: f.parameters ? object(f.parameters) : { type: "object", properties: {} } }];
  });
  const names = new Set<string>();
  for (const tool of parsed) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)) invalid("Tool names must be unique and use 1–64 letters, digits, underscores or hyphens (including namespace).");
    names.add(tool.name);
  }
  return parsed;
}

function namespaced(namespace: unknown, name: unknown) {
  if (!namespace) return string(name);
  const full = `${string(namespace)}__${string(name)}`;
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(full)) return full;
  // Stable across turns; reverse mapping is carried by the request's tool list.
  // Hash the tuple rather than its joined spelling to keep namespaces distinct.
  return `${string(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20)}_${createHash("sha256").update(JSON.stringify([namespace, name])).digest("hex").slice(0, 40)}`;
}

function choice(value: unknown, protocol: Protocol): GenerationRequest["toolChoice"] {
  if (value === undefined) return undefined;
  if (["auto", "none", "required"].includes(String(value))) return value as "auto" | "none" | "required";
  const v = object(value, "tool_choice");
  if (protocol === "anthropic") {
    if (v.type === "auto" || v.type === "none") return v.type;
    if (v.type === "any") return "required";
    if (v.type === "tool") return { name: string(v.name) };
  }
  if (v.type === "function" || v.type === "custom") {
    return { name: protocol === "chat" ? string(object(v.function).name) : namespaced(v.namespace, v.name) };
  }
  invalid("Unsupported tool_choice.");
}

const common = z.object({
  model: z.string().min(1).max(200), stream: z.boolean().default(false),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  parallel_tool_calls: z.boolean().optional(),
});
const reasoning = z.object({
  // Codex catalogs can advertise new, model-defined effort levels.
  effort: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  summary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
  context: z.enum(["auto", "current_turn", "all_turns"]).optional(),
}).strict();
const messagePhase = z.enum(["commentary", "final_answer"]).nullable();

export function parseRequest(raw: unknown, protocol: Protocol): GenerationRequest {
  const body = object(raw, "request");
  const checked = common.safeParse(body);
  if (!checked.success) invalid(checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const base = checked.data;
  for (const field of ["previous_response_id", "conversation", "background", "audio", "prediction", "thinking", "output_config"]) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== false) invalid(`${field} is not supported. Send complete conversation history.`);
  }
  if (body.n !== undefined && body.n !== 1) invalid("Only n=1 is supported.");
  if (body.response_format && object(body.response_format).type !== "text") invalid("Structured output is not supported by this adapter.");
  if (body.text && object(body.text).format && object(object(body.text).format).type !== "text") invalid("Structured output is not supported by this adapter.");
  if (body.store === true) invalid("Response storage is not supported; use store=false.");
  if (protocol === "anthropic" && body.max_tokens === undefined) invalid("max_tokens is required.");
  const maxTokens = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? 8192;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) invalid("max_tokens must be an integer between 1 and 32768.");
  const result: GenerationRequest = {
    model: base.model, stream: base.stream, temperature: base.temperature, topP: base.top_p,
    maxTokens, system: "", messages: [], tools: tools(body.tools, protocol),
    toolChoice: choice(body.tool_choice, protocol), parallelTools: base.parallel_tool_calls,
  };
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (protocol !== "responses") invalid("reasoning controls require the Responses API.");
    const parsed = reasoning.safeParse(body.reasoning);
    if (!parsed.success) invalid("reasoning must contain supported effort, summary, or context controls.");
    result.reasoning = parsed.data;
  }
  if (body.stop !== undefined || body.stop_sequences !== undefined) {
    const stop = body.stop ?? body.stop_sequences;
    result.stop = typeof stop === "string" ? [stop] : array(stop, "stop").map((v) => string(v));
  }
  const systems: string[] = [];
  if (body.system !== undefined) systems.push(textContent(body.system));
  if (body.instructions !== undefined && body.instructions !== null) systems.push(string(body.instructions));
  const input = protocol === "responses" ? body.input : body.messages;
  if (typeof input === "string" && protocol === "responses") {
    result.messages.push({ role: "user", content: [{ type: "text", text: input }] });
  } else {
    for (const value of array(input, protocol === "responses" ? "input" : "messages")) {
      const m = object(value);
      if (protocol === "responses" && m.type === "reasoning") {
        if (m.encrypted_content) invalid("Encrypted reasoning from another provider cannot be replayed.");
        continue; // Reasoning summaries are metadata, not assistant conversation text.
      }
      if (protocol === "responses" && (m.type === "function_call" || m.type === "custom_tool_call")) {
        result.messages.push({ role: "assistant", content: [{ type: "call", id: string(m.call_id), name: namespaced(m.namespace, m.name),
          arguments: m.type === "custom_tool_call" ? JSON.stringify({ input: string(m.input) }) : jsonArguments(m.arguments) }] });
        continue;
      }
      if (protocol === "responses" && (m.type === "function_call_output" || m.type === "custom_tool_call_output")) {
        result.messages.push({ role: "user", content: [{ type: "result", id: string(m.call_id), content: textContent(m.output) }] });
        continue;
      }
      if (m.phase !== undefined && (protocol !== "responses" || m.role !== "assistant" || !messagePhase.safeParse(m.phase).success)) {
        invalid("phase must be commentary, final_answer, or null on an assistant Responses message.");
      }
      if (m.role === "system" || m.role === "developer") { systems.push(textContent(m.content)); continue; }
      if (m.role === "tool") {
        result.messages.push({ role: "user", content: [{ type: "result", id: string(m.tool_call_id), content: textContent(m.content) }] }); continue;
      }
      if (m.role !== "user" && m.role !== "assistant") invalid(`Unsupported message role or input item: ${m.role ?? m.type}.`);
      const parts = m.content === null || m.content === undefined ? [] : content(m.content);
      if (m.tool_calls !== undefined) {
        for (const c of array(m.tool_calls)) {
          const call = object(c); const fn = object(call.function);
          parts.push({ type: "call", id: string(call.id), name: string(fn.name), arguments: jsonArguments(fn.arguments) });
        }
      }
      if (parts.some((p) => p.type === "call") && m.role !== "assistant") invalid("Tool calls must have the assistant role.");
      if (parts.some((p) => p.type === "result") && m.role !== "user") invalid("Tool results must have the user role.");
      if (!parts.length) invalid("Messages must contain content or tool calls.");
      result.messages.push({ role: m.role, content: parts, ...(m.phase !== undefined ? { phase: messagePhase.parse(m.phase) } : {}) });
    }
  }
  if (!result.messages.length) invalid("At least one conversation message is required.");
  result.system = systems.join("\n\n");
  // Anthropic requires consecutive same-role content to be in one message, in order.
  result.messages = result.messages.reduce<Message[]>((messages, m) => {
    const last = messages.at(-1);
    if (last?.role === m.role && last.phase === m.phase) last.content.push(...m.content); else messages.push(m);
    return messages;
  }, []);
  return result;
}
