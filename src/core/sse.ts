import { ApiError } from "./errors";

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event = "message";
  let eventSize = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length + eventSize > 1_048_576) throw new ApiError(502, "Upstream SSE frame exceeded the size limit.", "api_error");
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message"; data = []; eventSize = 0;
        } else if (line.startsWith("data:")) {
          const text = line.slice(5).replace(/^ /, "");
          data.push(text); eventSize += text.length;
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
      if (done) {
        if (buffer.trim() || data.length) throw new ApiError(502, "The upstream stream ended inside an SSE event.", "api_error");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

export async function readJSON(request: Request, limit = 1_048_576): Promise<unknown> {
  if (!request.body) throw new ApiError(400, "A JSON request body is required.");
  if (Number(request.headers.get("content-length")) > limit) throw new ApiError(413, "Request body is too large.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ApiError(413, "Request body is too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, "Request body must be valid JSON."); }
}
