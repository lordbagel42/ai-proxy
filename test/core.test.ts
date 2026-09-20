import { describe, expect, it } from "vitest";
import { parseRequest } from "../src/core/input";
import { collect, encodeStream, formatCompletion, streamResponse } from "../src/core/output";
import { readSSE, sse } from "../src/core/sse";
import { anthropicBody, anthropicEvents, chatBody, chatEvents, configuredProviders } from "../src/providers";
import type { Event, Protocol } from "../src/core/types";
import { anthropicFixture, bytes } from "./fixtures";

async function all<T>(source: AsyncIterable<T>): Promise<T[]> { const items: T[] = []; for await (const item of source) items.push(item); return items; }

const request = () => parseRequest({ model: "claude", input: "Hello", stream: true, store: false }, "responses");

describe("conversation translation", () => {
  it("preserves Codex tool calls and tool results over a complete second turn", () => {
    const parsed = parseRequest({ model: "claude", instructions: "Be helpful", input: [
      { role: "developer", content: [{ type: "input_text", text: "Use tools" }] },
      { role: "user", content: "Read this" },
      { type: "function_call", name: "read_file", call_id: "call_1", arguments: '{"path":"a.ts"}' },
      { type: "function_call_output", call_id: "call_1", output: "file contents" },
    ], tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }] }, "responses");
    expect(parsed.system).toBe("Be helpful\n\nUse tools");
    expect(anthropicBody(parsed, "real-model")).toMatchObject({ model: "real-model", messages: [
      { role: "user", content: [{ type: "text", text: "Read this" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file contents" }] },
    ] });
    expect(chatBody(parsed, "deepseek")).toMatchObject({ messages: [
      { role: "system" }, { role: "user" }, { role: "assistant", tool_calls: [{ id: "call_1" }] }, { role: "tool", tool_call_id: "call_1" },
    ] });
  });
  it("accepts images and Anthropic tool results without losing their IDs", () => {
    const parsed = parseRequest({ model: "claude", max_tokens: 100, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      { type: "tool_result", tool_use_id: "tool_1", content: "ok" },
    ] }] }, "anthropic");
    expect(parsed.messages[0]?.content).toEqual([{ type: "image", url: "data:image/png;base64,abc" }, { type: "result", id: "tool_1", content: "ok", isError: false }]);
  });
  it("preserves Responses Lite additional_tools and complete native tool history", () => {
    const parsed = parseRequest({ model: "codex", reasoning: { effort: "low", context: "auto" }, input: [
      { type: "additional_tools", id: "tools_native", role: "developer", tools: [
        { type: "namespace", name: "functions", tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }] },
        { type: "custom", name: "apply_patch", format: { type: "text" } },
      ] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Run the requested commands." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Write and read proof.txt." }] },
      { type: "function_call", namespace: "functions", name: "exec_command", call_id: "call_write", arguments: '{"cmd":"printf relay-tool-ok > proof.txt"}' },
      { type: "function_call_output", call_id: "call_write", output: "exit code 0" },
      { type: "function_call", namespace: "functions", name: "exec_command", call_id: "call_read", arguments: '{"cmd":"cat proof.txt"}' },
      { type: "function_call_output", call_id: "call_read", output: "relay-tool-ok" },
    ] }, "responses");
    expect(parsed.system).toBe("Run the requested commands.");
    expect(parsed.tools).toMatchObject([
      { name: "functions__exec_command", namespace: "functions", clientName: "exec_command" },
      { name: "apply_patch", custom: true },
    ]);
    expect(parsed.messages).toHaveLength(5);
    expect(parsed.messages[1]?.content[0]).toMatchObject({ type: "call", name: "functions__exec_command", id: "call_write" });
    expect(parsed.messages[4]?.content[0]).toEqual({ type: "result", id: "call_read", content: "relay-tool-ok" });
    expect(parsed.reasoning).toEqual({ effort: "low", context: "auto" });
  });
  it("combines distinct top-level and embedded tool definitions", () => {
    const parsed = parseRequest({ model: "codex", tools: [{ type: "function", name: "first" }], input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "second" }] },
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "third" }] },
      { role: "user", content: "Use the tools." },
    ] }, "responses");
    expect(parsed.tools.map(tool => tool.name)).toEqual(["first", "second", "third"]);
  });
  it.each([
    { role: "user", tools: [] }, { role: "assistant", tools: [] }, { role: "tool", tools: [] },
    { role: "developer" }, { role: "developer", tools: null },
    { role: "developer", tools: [], content: "ignored instruction" },
    { role: "developer", tools: [{ type: "web_search" }] },
  ])("rejects malformed or unsupported embedded tool definitions: %j", (item) => {
    expect(() => parseRequest({ model: "codex", input: [
      { type: "additional_tools", ...item }, { role: "user", content: "Hello" },
    ] }, "responses")).toThrow();
  });
  it("rejects ambiguous or dynamically scoped additional_tools instead of changing their meaning", () => {
    const tools = [{ type: "function", name: "exec_command" }];
    const additional = { type: "additional_tools", role: "developer", tools };
    expect(() => parseRequest({ model: "codex", tools, input: [additional, { role: "user", content: "Hello" }] }, "responses")).toThrow("Tool names must be unique");
    expect(() => parseRequest({ model: "codex", input: [additional, additional, { role: "user", content: "Hello" }] }, "responses")).toThrow("Tool names must be unique");
    expect(() => parseRequest({ model: "codex", input: [{ role: "user", content: "Hello" }, additional] }, "responses")).toThrow("before conversation");
    expect(() => parseRequest({ model: "codex", messages: [additional, { role: "user", content: "Hello" }] }, "chat")).toThrow("Responses API");
  });
  it("preserves distinct assistant phases when reconstructing Responses history", () => {
    const parsed = parseRequest({ model: "codex", input: [
      { role: "user", content: "Read the file." },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Reading it now." }] },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "It contains the result." }] },
      { type: "message", role: "assistant", phase: null, content: [{ type: "output_text", text: "Legacy phase." }] },
    ] }, "responses");
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages.map((message) => message.phase)).toEqual([undefined, "commentary", "final_answer", null]);
  });
  it("accepts validated Responses reasoning controls, including model-defined efforts", () => {
    const reasoning = { effort: "ultra", summary: "detailed", context: "current_turn" };
    expect(parseRequest({ model: "codex", input: "Hello", reasoning }, "responses").reasoning).toEqual(reasoning);
    expect(parseRequest({ model: "codex", input: "Hello", reasoning: { effort: "future_level" } }, "responses").reasoning)
      .toEqual({ effort: "future_level" });
    expect(() => parseRequest({ model: "codex", messages: [{ role: "user", content: "Hello" }], reasoning }, "chat"))
      .toThrow("require the Responses API");
  });
  it.each([
    { previous_response_id: "old" }, { store: true }, { background: true }, { max_output_tokens: 999999 },
    { tools: [{ type: "web_search" }] }, { response_format: { type: "json_object" } },
    { input: [{ type: "function_call", name: "x", call_id: "1", arguments: "oops" }] },
    { reasoning: { effort: 2 } }, { reasoning: { effort: "" } }, { reasoning: { summary: "verbose" } },
    { reasoning: { effort: "high", budget_tokens: 100 } }, { reasoning: { context: "arbitrary" } },
    { input: [{ role: "assistant", phase: "analysis", content: "Hidden" }] },
    { input: [{ role: "user", phase: "final_answer", content: "Hello" }] },
  ])("rejects unsupported requests before contacting an upstream: %j", (bad) => {
    expect(() => parseRequest({ model: "claude", input: "hello", ...bad }, "responses")).toThrow();
  });
  it("rejects ambiguous model aliases and unsafe provider URLs", () => {
    const provider = { id: "one", protocol: "anthropic", baseUrl: "https://example.com/v1", credential: "TOKEN", models: { claude: "real" } };
    expect(() => configuredProviders(JSON.stringify([provider, { ...provider, id: "two" }]))).toThrow();
    expect(() => configuredProviders(JSON.stringify([{ ...provider, baseUrl: "http://external.example/v1" }]))).toThrow();
  });
  it("maps long Codex namespaces to stable upstream names and reverses the result", async () => {
    const namespace = "mcp__codex_apps__a_provider_with_a_long_namespace";
    const name = "a_long_tool_name_that_would_exceed_the_upstream_limit";
    const r = parseRequest({ model: "claude", input: [
      { type: "function_call", namespace, name, call_id: "call_long", arguments: "{}" },
      { type: "function_call_output", call_id: "call_long", output: "done" },
    ], tools: [{ type: "namespace", name: namespace, tools: [{ type: "function", name, parameters: { type: "object" } }] }] }, "responses");
    const alias = r.tools[0]!.name;
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(r.messages[0]!.content[0]).toMatchObject({ name: alias });
    async function* events(): AsyncGenerator<Event> {
      yield { type: "tool_start", index: 0, name: alias, id: "call_new" };
      yield { type: "tool_delta", index: 0, arguments: "{}" };
      yield { type: "block_stop", index: 0 }; yield { type: "finish", reason: "tool_calls" };
    }
    const result = formatCompletion(await collect(events(), r), "responses", r);
    expect(result.output).toMatchObject([{ namespace, name, call_id: "call_new" }]);
  });
});

describe("stream compatibility", () => {
  it.each<Protocol>(["anthropic", "chat", "responses"])("streams UTF-8 text and final usage as %s", async (protocol) => {
    const response = streamResponse(encodeStream(anthropicEvents(bytes(anthropicFixture().replaceAll("\n", "\r\n"), 1)), protocol, request()), new AbortController());
    const frames = await all(readSSE(response.body!));
    const output = frames.map((e) => e.data).join("\n");
    expect(output).toContain("friend 🌱");
    if (protocol === "responses") {
      const final = JSON.parse(frames.at(-1)!.data);
      expect(final.type).toBe("response.completed");
      expect(final.response.usage).toMatchObject({ input_tokens: 13, output_tokens: 7, total_tokens: 20 });
      expect(frames.map((e) => JSON.parse(e.data).sequence_number)).toEqual(frames.map((_, i) => i));
    } else if (protocol === "chat") expect(frames.at(-1)?.data).toBe("[DONE]");
    else expect(frames.at(-1)?.event).toBe("message_stop");
  });
  it.each<Protocol>(["anthropic", "chat", "responses"])("preserves streamed and buffered tool arguments as %s", async (protocol) => {
    const completion = await collect(anthropicEvents(bytes(anthropicFixture(true))), request());
    expect(completion.blocks).toEqual([{ type: "tool", id: "call_demo", name: "read_file", arguments: '{"path":"README.md"}' }]);
    const serialized = JSON.stringify(formatCompletion(completion, protocol, request()));
    expect(serialized).toContain("call_demo");
    const output = (await all(encodeStream(anthropicEvents(bytes(anthropicFixture(true))), protocol, request()))).join("");
    expect(output).toContain("call_demo"); expect(output).toContain("README.md");
  });
  it("supports a complete OpenAI-compatible upstream stream", async () => {
    const body = [
      sse({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{}' } }] }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 8 } }), sse("[DONE]"),
    ].join("");
    const result = await collect(chatEvents(bytes(body)), request());
    expect(result.reason).toBe("tool_calls"); expect(result.usage).toMatchObject({ input: 5, output: 8 });
    expect(result.blocks).toHaveLength(2);
  });
  it("emits response.failed rather than completion for a truncated stream", async () => {
    const broken = anthropicFixture().replace(sse({ type: "message_stop" }, "message_stop"), "");
    const output = (await all(encodeStream(anthropicEvents(bytes(broken)), "responses", request()))).join("");
    expect(output).toContain("response.failed"); expect(output).not.toContain('"status":"completed","model"');
    await expect(collect(anthropicEvents(bytes(broken)), request())).rejects.toThrow("message_stop");
  });
  it("emits Codex custom-tool items and input instead of a function wrapper", async () => {
    const r = parseRequest({ model: "claude", input: "Patch it", tools: [{ type: "custom", name: "apply_patch" }] }, "responses");
    async function* events(): AsyncGenerator<Event> {
      yield { type: "tool_start", index: 0, id: "call_patch", name: "apply_patch" };
      yield { type: "tool_delta", index: 0, arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' };
      yield { type: "block_stop", index: 0 }; yield { type: "finish", reason: "tool_calls" };
    }
    const output = (await all(encodeStream(events(), "responses", r))).join("");
    expect(output).toContain("response.custom_tool_call_input.done");
    expect(output).toContain("*** Begin Patch"); expect(output).not.toContain("response.function_call_arguments");
  });
  it("aborts upstream work when the downstream reader cancels", async () => {
    const controller = new AbortController(); let closed = false;
    async function* source() { try { yield "one"; yield "two"; } finally { closed = true; } }
    const reader = streamResponse(source(), controller).body!.getReader();
    await reader.read(); await reader.cancel();
    expect(controller.signal.aborted).toBe(true); expect(closed).toBe(true);
  });
});
