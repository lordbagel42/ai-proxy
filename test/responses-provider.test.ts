import { describe, expect, it } from "vitest";
import { collect, encodeStream } from "../src/core/output";
import { sse } from "../src/core/sse";
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
      { role: "assistant", content: [{ type: "input_text", text: "Reading" }] },
      { type: "function_call", call_id: "call_old", name: "read_file", arguments: '{"path":"old.txt"}' },
      { role: "assistant", content: [{ type: "input_text", text: "Wait" }] },
      { type: "function_call_output", call_id: "call_old", output: "Old file" },
      { role: "user", content: [{ type: "input_text", text: "Now this" }, { type: "input_image", image_url: "https://example.com/image.png", detail: "auto" }] },
    ]);
  });
  it("rejects unsupported stop sequences instead of dropping them", () => {
    expect(() => responsesBody({ ...request(), stop: ["END"] }, "codex")).toThrow("stop sequences");
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
