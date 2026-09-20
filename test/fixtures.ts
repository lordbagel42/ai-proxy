import { sse } from "../src/core/sse";

export function anthropicFixture(tool = false): string {
  const block = tool ? { type: "tool_use", id: "call_demo", name: "read_file", input: {} } : { type: "text", text: "" };
  return [
    { type: "message_start", message: { id: "msg_upstream", usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: '{"path":' } : { type: "text_delta", text: "Hello " } },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: '"README.md"}' } : { type: "text_delta", text: "friend 🌱" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ].map((e) => sse(e, e.type)).join("");
}
export function bytes(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const data = new TextEncoder().encode(text); let position = 0;
  return new ReadableStream({ pull(controller) {
    if (position === data.length) { controller.close(); return; }
    controller.enqueue(data.slice(position, position += chunkSize));
    position = Math.min(position, data.length);
  } });
}
