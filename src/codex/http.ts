import { ApiError } from "../core/errors";
import type { JsonObject } from "../core/types";

// Identify this gateway consistently across its Worker and Node runtimes.
// HTTP Responses does not use the WebSocket beta header.
export const CLIENT_USER_AGENT = "codex_cli_rs/0.154.0 (ai-proxy)";
const KNOWN_ERROR_CODES = new Set([
  "unsupported_country_region_territory", "account_deactivated", "account_suspended", "access_denied",
  "insufficient_permissions", "permission_denied", "insufficient_quota", "rate_limit_exceeded",
  "model_not_found", "invalid_api_key", "invalid_request_error", "token_expired",
]);

async function upstreamErrorCode(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel(); return "unknown";
  }
  const reader = response.body.getReader();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(2_000)]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  deadline.addEventListener("abort", cancel, { once: true });
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    if (deadline.aborted) return "unknown";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) return "unknown";
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
    const error = (parsed as JsonObject).error;
    const code = typeof error === "string" ? error
      : error && typeof error === "object" && !Array.isArray(error) ? (error as JsonObject).code : undefined;
    return typeof code === "string" && KNOWN_ERROR_CODES.has(code) ? code : "unknown";
  } catch { return "unknown"; }
  finally {
    deadline.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

function responseMetadata(response: Response) {
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const contentType = !mediaType ? "missing" : ["application/json", "text/html", "text/plain", "text/event-stream"].includes(mediaType) ? mediaType : "other";
  const serverHeader = response.headers.get("server");
  const server = !serverHeader ? "missing" : serverHeader.toLowerCase() === "cloudflare" ? "cloudflare" : "other";
  const challenge = response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
  const ray = response.headers.get("cf-ray");
  return { contentType, server, challenge, cfRay: ray && /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(ray) ? ray : undefined };
}

/** Diagnose unexpected successful HTTP responses without reading provider content. */
export function codexStreamRejection(response: Response): ApiError {
  const { contentType, server, challenge, cfRay } = responseMetadata(response);
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  const contentEncoding = !encoding ? "missing" : ["identity", "gzip", "deflate", "br", "zstd"].includes(encoding) ? encoding : "other";
  console.warn(JSON.stringify({ code: "codex_upstream_unexpected_response", operation: "responses", upstreamStatus: response.status,
    contentType, server, challenge, bodyPresent: response.body !== null, contentEncoding, ...(cfRay ? { cfRay } : {}) }));
  return new ApiError(502, "Codex did not return an event stream.", "api_error");
}

export async function codexRejection(response: Response, signal: AbortSignal, operation: "models" | "responses"): Promise<ApiError> {
  const upstreamCode = await upstreamErrorCode(response, signal);
  const { contentType, server, challenge, cfRay } = responseMetadata(response);
  // Only categorical metadata, known error codes and a validated diagnostic ID
  // reach logs. Never log provider text, arbitrary headers, prompts or credentials.
  console.warn(JSON.stringify({ code: "codex_upstream_rejected", operation, upstreamStatus: response.status,
    contentType, server, challenge, upstreamCode, ...(cfRay ? { cfRay } : {}) }));
  if (challenge) return new ApiError(502, "ChatGPT returned a browser challenge to the gateway.", "codex_upstream_challenge");
  if (response.status === 403 && upstreamCode === "unsupported_country_region_territory") {
    return new ApiError(502, "ChatGPT does not allow requests from this gateway's region.", "codex_upstream_region_restricted");
  }
  if (response.status === 403) return new ApiError(502, "ChatGPT denied the gateway request (HTTP 403).", "codex_upstream_forbidden");
  return new ApiError(response.status === 429 ? 429 : 502, `Codex returned HTTP ${response.status}.`,
    response.status === 429 ? "rate_limit_error" : "api_error", response.headers.get("retry-after") ?? undefined);
}
