import type { Protocol } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = "invalid_request_error", public retryAfter?: string) {
    super(message);
  }
}

export function errorBody(error: ApiError, protocol: Protocol = "responses") {
  if (protocol === "anthropic") {
    return { type: "error", error: { type: error.code, message: error.message } };
  }
  return { error: { message: error.message, type: error.code, code: error.code, param: null } };
}

export function publicError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new ApiError(504, "The upstream request timed out or was cancelled.", "timeout_error");
  }
  return new ApiError(500, "The proxy could not complete the request.", "api_error");
}

export function invalid(message: string): never { throw new ApiError(400, message); }
