import { describe, expect, it } from "vitest";
import { parseRequest } from "../src/core/input";
import { collect, encodeStream, formatCompletion } from "../src/core/output";
import { readSSE, sse } from "../src/core/sse";
import type { GenerationRequest, JsonObject } from "../src/core/types";
import { responsesBody, responsesEvents } from "../src/providers/responses";
import { bytes } from "./fixtures";

const request = (): GenerationRequest => ({ model: "codex", system: "Be helpful.", messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [{ name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }], maxTokens: 4096, stream: true });
function fixture(tool = false, incomplete = false): JsonObject[] {
  const id = "resp_upstream"; const item_id = tool ? "fc_read" : "msg_reply";
  const content = { type: "output_text", text: "Hello 🌱", annotations: [] };
  const finalItem = tool ? { type: "function_call", id: item_id, call_id: "call_read", name: "read_file", arguments: '{"path":"README.md"}', status: "completed" }
    : { type: "message", id: item_id, role: "assistant", content: [content], status: "completed" };
  const coords = { output_index: 0, item_id };
  const events: JsonObject[] = [
    { type: "response.created", response: { id, status: "in_progress" } },
    { type: "response.in_progress", response: { id, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: tool ? { ...finalItem, arguments: "", status: "in_progress" } : { ...finalItem, content: [], status: "in_progress" } },
  ];
  if (tool) events.push(
    { type: "response.function_call_arguments.delta", ...coords, delta: '{"path":' },
    { type: "response.function_call_arguments.delta", ...coords, delta: '"README.md"}' },
    { type: "response.function_call_arguments.done", ...coords, arguments: finalItem.arguments, name: "read_file" },
  );
  else events.push(
    { type: "response.content_part.added", ...coords, content_index: 0, part: { ...content, text: "" } },
    { type: "response.output_text.delta", ...coords, content_index: 0, delta: "Hello 🌱" },
    { type: "response.output_text.done", ...coords, content_index: 0, text: "Hello 🌱" },
    { type: "response.content_part.done", ...coords, content_index: 0, part: content },
  );
  events.push({ type: "response.output_item.done", output_index: 0, item: finalItem },
    { type: `response.${incomplete ? "incomplete" : "completed"}`, response: { id, status: incomplete ? "incomplete" : "completed", output: [finalItem],
      incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
      usage: { input_tokens: 21, input_tokens_details: { cached_tokens: 8 }, output_tokens: 7 } } });
  return events;
}
const stream = (events: JsonObject[]) => bytes(events.map((event, sequence_number) => sse({ sequence_number, ...event }, String(event.type))).join(""), 1);

describe("Responses upstream request", () => {
  it("preserves mixed history order and converts schemas without forcing strict required properties", () => {
    const r = request(); r.toolChoice = { name: "read_file" }; r.parallelTools = false;
    r.messages = [
      { role: "assistant", content: [{ type: "text", text: "Reading" }, { type: "call", id: "call_old", name: "read_file", arguments: '{"path":"old.txt"}' }, { type: "text", text: "Wait" }] },
      { role: "user", content: [{ type: "result", id: "call_old", content: "Old file" }, { type: "text", text: "Now this" }, { type: "image", url: "https://example.com/image.png" }] },
    ];
    const body = responsesBody(r, "upstream-codex");
    expect(body).toMatchObject({ model: "upstream-codex", store: false, stream: true, max_output_tokens: 4096, instructions: "Be helpful.", parallel_tool_calls: false,
      tool_choice: { type: "function", name: "read_file" }, tools: [{ type: "function", strict: false, name: "read_file", parameters: r.tools[0]!.parameters }] });
    expect(body.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "Reading" }] },
      { type: "function_call", call_id: "call_old", name: "read_file", arguments: '{"path":"old.txt"}' },
      { role: "assistant", content: [{ type: "output_text", text: "Wait" }] },
      { type: "function_call_output", call_id: "call_old", output: "Old file" },
      { role: "user", content: [{ type: "input_text", text: "Now this" }, { type: "input_image", image_url: "https://example.com/image.png", detail: "auto" }] },
    ]);
  });
  it("rejects unsupported stop sequences instead of dropping them", () => {
    expect(() => responsesBody({ ...request(), stop: ["END"] }, "codex")).toThrow("stop sequences");
  });
  it("replays assistant commentary and mixed custom/function tool history with role-correct text", () => {
    const r = parseRequest({ model: "codex", input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [
        { type: "custom", name: "apply_patch" },
        { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
      ] }] },
      { role: "user", content: [{ type: "input_text", text: "Write and read proof.txt." }] },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Creating the file." }] },
      { type: "custom_tool_call", namespace: "functions", name: "apply_patch", call_id: "call_patch", input: "*** Begin Patch\n*** Add File: proof.txt\n+relay-tool-ok\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: [{ type: "input_text", text: "Success" }] },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Reading the file." }] },
      { type: "function_call", namespace: "functions", name: "exec_command", call_id: "call_read", arguments: '{"cmd":"sed -n \'1p\' proof.txt"}' },
      { type: "function_call_output", call_id: "call_read", output: "relay-tool-ok" },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
      { role: "user", content: "Continue." },
    ] }, "responses");
    const body = responsesBody(r, "real-model");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Write and read proof.txt." }] },
      { role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Creating the file." }] },
      { type: "function_call", name: "functions__apply_patch", call_id: "call_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Add File: proof.txt\n+relay-tool-ok\n*** End Patch" }) },
      { type: "function_call_output", call_id: "call_patch", output: "Success" },
      { role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Reading the file." }] },
      { type: "function_call", name: "functions__exec_command", call_id: "call_read", arguments: '{"cmd":"sed -n \'1p\' proof.txt"}' },
      { type: "function_call_output", call_id: "call_read", output: "relay-tool-ok" },
      { role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
      { role: "user", content: [{ type: "input_text", text: "Continue." }] },
    ]);
    expect((body.tools as JsonObject[]).map(tool => tool.name)).toEqual(["functions__apply_patch", "functions__exec_command"]);
  });
  it("forwards reasoning settings and assistant phases to the Responses backend", () => {
    const r = parseRequest({ model: "codex", reasoning: { effort: "high", summary: "concise", context: "all_turns" }, input: [
      { role: "assistant", phase: "commentary", content: "Checking." },
      { role: "assistant", phase: "final_answer", content: "Finished." },
      { role: "user", content: "Continue." },
    ] }, "responses");
    expect(responsesBody(r, "real-model")).toMatchObject({
      reasoning: { effort: "high", summary: "concise", context: "all_turns" },
      input: [
        { role: "assistant", phase: "commentary" },
        { role: "assistant", phase: "final_answer" },
        { role: "user" },
      ],
    });
    expect((responsesBody(r, "real-model").input as JsonObject[])[2]).not.toHaveProperty("phase");
  });
});

describe("Responses upstream stream", () => {
  it("decodes fragmented UTF-8 text, cached usage and completion", async () => {
    const result = await collect(responsesEvents(stream(fixture())), request());
    expect(result.blocks).toEqual([{ type: "text", text: "Hello 🌱" }]);
    expect(result.usage).toEqual({ input: 21, output: 7, cached: 8 });
    expect(result.reason).toBe("stop");
  });
  it("decodes tool calls and their JSON arguments", async () => {
    const result = await collect(responsesEvents(stream(fixture(true))), request());
    expect(result.blocks).toEqual([{ type: "tool", id: "call_read", name: "read_file", arguments: '{"path":"README.md"}' }]);
    expect(result.reason).toBe("tool_calls");
  });
  it.each([false, true])("accepts Codex's empty terminal output after validated items (tool=%s)", async (tool) => {
    const events = fixture(tool);
    (events.at(-1)!.response as JsonObject).output = [];
    const result = await collect(responsesEvents(stream(events), { allowEmptyTerminalOutput: true }), request());
    expect(result.blocks).toEqual(tool
      ? [{ type: "tool", id: "call_read", name: "read_file", arguments: '{"path":"README.md"}' }]
      : [{ type: "text", text: "Hello 🌱" }]);
    expect(result.usage).toEqual({ input: 21, output: 7, cached: 8 });
    expect(result.reason).toBe(tool ? "tool_calls" : "stop");
    // Generic Responses providers retain full terminal-snapshot validation.
    await expect(collect(responsesEvents(stream(events)), request())).rejects.toThrow("invalid Responses event");
  });
  it.each(["missing", "null", "wrong item", "wrong response", "wrong status", "open item", "text changed"])(
    "keeps Codex terminal validation for %s", async (change) => {
      const events = fixture();
      const terminal = events.at(-1)!.response as JsonObject;
      terminal.output = [];
      if (change === "missing") delete terminal.output;
      if (change === "null") terminal.output = null;
      if (change === "wrong item") terminal.output = [{ id: "wrong", type: "message", role: "assistant", content: [] }];
      if (change === "wrong response") terminal.id = "wrong";
      if (change === "wrong status") terminal.status = "in_progress";
      if (change === "open item") events.splice(events.findIndex((event) => event.type === "response.output_item.done"), 1);
      if (change === "text changed") events.find((event) => event.type === "response.output_text.done")!.text = "Different text";
      await expect(collect(responsesEvents(stream(events), { allowEmptyTerminalOutput: true }), request())).rejects.toMatchObject({ status: 502 });
    },
  );
  it.each([false, true])("validates the final item even when Codex omits the terminal snapshot (tool=%s)", async (tool) => {
    const events = fixture(tool);
    (events.at(-1)!.response as JsonObject).output = [];
    const item = events.find((event) => event.type === "response.output_item.done")!.item as JsonObject;
    if (tool) item.arguments = '{"path":"changed.txt"}';
    else item.content = [{ type: "output_text", text: "Changed text", annotations: [] }];
    await expect(collect(responsesEvents(stream(events), { allowEmptyTerminalOutput: true }), request())).rejects.toMatchObject({ status: 502 });
  });
  it("tolerates Codex transport metadata before and during an otherwise validated stream", async () => {
    const events = fixture();
    events.unshift({ type: "codex.response.metadata", metadata: { routing: "test" } });
    events.splice(4, 0, { type: "response.metadata", metadata: { safety_buffering: { type: "disabled" } } });
    events.splice(-1, 0, { type: "responsesapi.websocket_timing", timings: { queue_ms: 1 } });
    expect((await collect(responsesEvents(stream(events)), request())).blocks).toEqual([{ type: "text", text: "Hello 🌱" }]);
  });
  it("preserves phases supplied only on finalized items through streaming and replay", async () => {
    const first = fixture(); const second = fixture();
    for (const event of second) {
      if (event.output_index !== undefined) event.output_index = 1;
      if (event.item_id !== undefined) event.item_id = "msg_final";
      if (event.item) (event.item as JsonObject).id = "msg_final";
    }
    const firstItem = first.find((event) => event.type === "response.output_item.done")!.item as JsonObject;
    firstItem.phase = "commentary";
    const secondItem = second.find((event) => event.type === "response.output_item.done")!.item as JsonObject;
    secondItem.phase = "final_answer";
    (second.find((event) => event.type === "response.output_item.added")!.item as JsonObject).phase = null;
    const completed = second.at(-1)!;
    (completed.response as JsonObject).output = [firstItem, secondItem];
    const events = [...first.slice(0, -1), ...second.slice(2, -1), completed];
    const completion = await collect(responsesEvents(stream(events)), request());
    expect(completion.blocks.map((block) => block.type === "text" && block.phase)).toEqual(["commentary", "final_answer"]);
    const output = formatCompletion(completion, "responses", request()).output as JsonObject[];
    const replay = parseRequest({ model: "codex", input: output }, "responses");
    expect((responsesBody(replay, "codex").input as JsonObject[]).map((item) => item.phase)).toEqual(["commentary", "final_answer"]);
    let encoded = "";
    for await (const frame of encodeStream(responsesEvents(stream(events)), "responses", request())) encoded += frame;
    const frames: JsonObject[] = [];
    for await (const frame of readSSE(bytes(encoded))) frames.push(JSON.parse(frame.data));
    expect(frames.filter((frame) => frame.type === "response.output_item.done").map((frame) => (frame.item as JsonObject).phase))
      .toEqual(["commentary", "final_answer"]);
    expect(((frames.at(-1)!.response as JsonObject).output as JsonObject[]).map((item) => item.phase)).toEqual(["commentary", "final_answer"]);
  });
  it("rejects unsupported content events and invalid assistant phases", async () => {
    const events = fixture();
    events.splice(4, 0, { type: "response.some_new_content.delta", delta: "Would be lost" });
    await expect(collect(responsesEvents(stream(events)), request())).rejects.toThrow("unsupported Responses event");
    const badPhase = fixture();
    (badPhase.find((event) => event.type === "response.output_item.done")!.item as JsonObject).phase = "analysis";
    await expect(collect(responsesEvents(stream(badPhase)), request())).rejects.toThrow("invalid assistant message phase");
  });
  it("reports max-output-token termination as length", async () => {
    expect((await collect(responsesEvents(stream(fixture(false, true))), request())).reason).toBe("length");
  });
  it("ignores reasoning output without losing the following text", async () => {
    const events = fixture();
    for (const event of events) if (event.output_index !== undefined) event.output_index = 1;
    const reasoning = { id: "rs_private", type: "reasoning", summary: [] };
    events.splice(2, 0,
      { type: "response.output_item.added", output_index: 0, item: reasoning },
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: reasoning.id, delta: "Thinking" },
      { type: "response.output_item.done", output_index: 0, item: reasoning });
    ((events.at(-1)!.response as JsonObject).output as JsonObject[]).unshift(reasoning);
    expect((await collect(responsesEvents(stream(events)), request())).blocks).toEqual([{ type: "text", text: "Hello 🌱" }]);
  });
  it("fails on a truncated stream instead of emitting a successful downstream completion", async () => {
    const events = fixture().slice(0, -1);
    await expect(collect(responsesEvents(stream(events)), request())).rejects.toThrow("before response.completed");
    let output = "";
    for await (const frame of encodeStream(responsesEvents(stream(events)), "responses", request())) output += frame;
    expect(output).toContain("event: response.failed\n"); expect(output).not.toContain("event: response.completed\n");
  });
  it("sanitizes upstream streaming failures", async () => {
    await expect(collect(responsesEvents(stream([{ type: "response.failed", response: { error: { message: "private credential detail" } } }])), request()))
      .rejects.toThrow("The upstream provider returned a streaming error.");
  });
  it("rejects terminal completion while an output item is open", async () => {
    const events = fixture().filter((event) => event.type !== "response.output_item.done");
    await expect(collect(responsesEvents(stream(events)), request())).rejects.toThrow("left a Responses output item open");
  });
  it("rejects mismatched item identifiers and repeated event sequences", async () => {
    const events = fixture();
    events.find((event) => event.type === "response.output_text.delta")!.item_id = "another_item";
    await expect(collect(responsesEvents(stream(events)), request())).rejects.toThrow("out-of-order");
    const repeated = fixture(); repeated[1]!.sequence_number = 0;
    await expect(collect(responsesEvents(stream(repeated)), request())).rejects.toThrow("event sequence");
  });
  it("rejects unsupported hosted tools and filtered incomplete responses", async () => {
    const events = fixture(); events[2]!.item = { type: "web_search_call", id: "web_1" };
    await expect(collect(responsesEvents(stream(events)), request())).rejects.toThrow("unsupported Responses output item");
    const filtered = fixture(false, true);
    (filtered.at(-1)!.response as JsonObject).incomplete_details = { reason: "content_filter" };
    await expect(collect(responsesEvents(stream(filtered)), request())).rejects.toThrow("could not complete");
  });
  it("rejects tool argument changes between delta and done events", async () => {
    const events = fixture(true);
    events.find((event) => event.type === "response.function_call_arguments.done")!.arguments = '{"path":"other-file"}';
    await expect(collect(responsesEvents(stream(events)), request())).rejects.toThrow("invalid Responses event");
  });
});
