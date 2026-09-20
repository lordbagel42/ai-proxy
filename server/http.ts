import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { AppEnv } from "../src/env";
import worker from "../src/worker";

export type ApplicationHandler = (request: Request, env: AppEnv, context: ExecutionContext) => Response | Promise<Response>;
export interface ApplicationServerOptions {
  trustedProxies?: string[];
  shutdownGraceMs?: number;
  handler?: ApplicationHandler;
}

const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const clientIdentityHeaders = new Set(["forwarded", "x-real-ip", "true-client-ip", "cf-connecting-ip", "cf-connecting-ipv6", "cf-pseudo-ipv4", "cf-worker", "cf-ray", "cf-visitor"]);

function proxyAllowlist(entries: string[]): (address: string) => boolean {
  const list = new BlockList();
  for (const entry of entries) {
    const parts = entry.trim().split("/");
    const address = parts[0]!;
    const version = isIP(address);
    if (!version || parts.length > 2) throw new Error("TRUSTED_PROXY_IPS must contain only IP addresses or CIDR networks.");
    const type = version === 4 ? "ipv4" : "ipv6";
    if (parts.length === 1) list.addAddress(address, type);
    else {
      const prefix = parts[1]!;
      if (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)) {
        throw new Error("TRUSTED_PROXY_IPS contains an invalid CIDR prefix.");
      }
      list.addSubnet(address, Number(prefix), type);
    }
  }
  return (address) => {
    const version = isIP(address);
    return version !== 0 && list.check(address, version === 4 ? "ipv4" : "ipv6");
  };
}

function requestHeaders(message: IncomingMessage, origin: URL, trustedPeer: (address: string) => boolean): Headers {
  const headers = new Headers();
  const connectionHeaders = new Set((message.headers.connection ?? "").toLowerCase().split(",").map((value) => value.trim()));
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    const name = message.rawHeaders[i]!.toLowerCase();
    if (hopByHop.has(name) || connectionHeaders.has(name) || clientIdentityHeaders.has(name) || name.startsWith("x-forwarded-") || name === "host") continue;
    headers.append(name, message.rawHeaders[i + 1]!);
  }
  headers.set("host", origin.host);
  const peer = message.socket.remoteAddress ?? "";
  const claimed = message.headers["cf-connecting-ip"];
  // Only the immediate, explicitly trusted proxy can supply the client identity.
  // That proxy must itself overwrite this header at its external ingress.
  const client = trustedPeer(peer) && typeof claimed === "string" && isIP(claimed) ? claimed : peer;
  if (isIP(client)) headers.set("cf-connecting-ip", client.replace(/^::ffff:(?=\d+\.)/, ""));
  return headers;
}

function requestBody(message: IncomingMessage, signal: AbortSignal): ReadableStream<Uint8Array> {
  // IncomingMessage shares its socket with ServerResponse. Adapting it directly
  // would destroy that socket when readJSON cancels an oversized upload, before
  // the rejection response can be sent. Cancel only this bounded intermediary;
  // discardUpload closes the source after the response has finished flushing.
  const body = new PassThrough({ highWaterMark: 65_536 });
  const fail = (error: Error) => body.destroy(error);
  const abort = () => body.destroy(new Error("HTTP request aborted."));
  body.once("close", () => {
    message.unpipe(body);
    message.pause();
    message.off("error", fail);
    signal.removeEventListener("abort", abort);
  });
  message.once("error", fail);
  signal.addEventListener("abort", abort, { once: true });
  const stream = Readable.toWeb(body, { strategy: { highWaterMark: 65_536, size: (chunk: Buffer) => chunk.byteLength } }) as unknown as ReadableStream<Uint8Array>;
  if (signal.aborted) abort();
  else message.pipe(body);
  return stream;
}

function applicationRequest(message: IncomingMessage, origin: URL, signal: AbortSignal, trustedPeer: (address: string) => boolean): Request {
  const target = message.url ?? "/";
  // Accept origin-form targets only. In particular //host and absolute-form
  // targets must never choose the application's trusted OAuth/callback origin.
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\") || target.includes("#")) {
    throw new TypeError("Invalid HTTP request target.");
  }
  const url = new URL(`${origin.origin}${target}`);
  const method = message.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers: requestHeaders(message, origin, trustedPeer), signal };
  if (method !== "GET" && method !== "HEAD") {
    init.body = requestBody(message, signal);
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function sendResponse(response: Response, outgoing: ServerResponse, method: string, signal: AbortSignal): Promise<void> {
  outgoing.statusCode = response.status;
  if (response.statusText) outgoing.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie" && !hopByHop.has(name)) outgoing.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("set-cookie", cookies);
  if (method === "HEAD" || !response.body) {
    if (response.body) await response.body.cancel();
    outgoing.end();
    return;
  }
  // Flush SSE headers immediately; pipeline preserves backpressure and cancels
  // the Web stream when the client disconnects or shutdown aborts the request.
  outgoing.flushHeaders();
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), outgoing, { signal });
}

export function createApplicationServer(env: AppEnv, options: ApplicationServerOptions = {}) {
  const origin = new URL(env.BETTER_AUTH_URL);
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("BETTER_AUTH_URL must be an HTTP(S) URL.");
  const trustedPeer = proxyAllowlist(options.trustedProxies ?? []);
  const handler = options.handler ?? worker.fetch;
  const grace = options.shutdownGraceMs ?? 30_000;
  if (!Number.isFinite(grace) || grace < 0) throw new Error("shutdownGraceMs must be a non-negative number.");
  const requests = new Set<Promise<void>>();
  const background = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let closing = false;
  let closed: Promise<{ forced: boolean }> | undefined;

  function waitUntil(promise: Promise<unknown>): void {
    const tracked = Promise.resolve(promise).then(() => {}, () => {
      // Do not log exceptions: upstream errors may include private credentials.
      console.error(JSON.stringify({ code: "background_task_failed" }));
    }).finally(() => { background.delete(tracked); });
    background.add(tracked);
  }

  async function drain(): Promise<void> {
    // Tasks can register additional cleanup while settling, so drain to a fixed point.
    while (requests.size || background.size) await Promise.allSettled([...requests, ...background]);
  }

  const server = createServer({ requestTimeout: 300_000, headersTimeout: 60_000 }, (incoming, outgoing) => {
    if (closing) {
      outgoing.writeHead(503, { "content-type": "application/json", connection: "close" });
      outgoing.end('{"error":"Server shutting down."}');
      incoming.resume();
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort(new Error("HTTP client disconnected."));
    const incomingClosed = () => { if (!incoming.complete) abort(); };
    const outgoingClosed = () => { if (!outgoing.writableFinished) abort(); };
    incoming.once("aborted", abort);
    incoming.once("error", abort);
    incoming.once("close", incomingClosed);
    outgoing.once("close", outgoingClosed);
    const discardUpload = () => {
      if (incoming.complete || incoming.destroyed) return;
      const discard = () => {
        controller.abort(new Error("HTTP request body was not consumed."));
        incoming.destroy();
      };
      // Closing the incoming message also closes its socket. Wait until the
      // rejection response is flushed so the client receives its status/body.
      if (outgoing.writableFinished || outgoing.destroyed) discard();
      else outgoing.once("finish", discard);
    };
    const context = { waitUntil, passThroughOnException() {}, props: {}, exports: {}, abort: (reason?: unknown) => controller.abort(reason) } as unknown as ExecutionContext;
    const operation = (async () => {
      let request: Request;
      try { request = applicationRequest(incoming, origin, controller.signal, trustedPeer); }
      catch {
        outgoing.writeHead(400, { "content-type": "application/json", connection: "close" });
        outgoing.end('{"error":"Invalid HTTP request."}');
        discardUpload();
        return;
      }
      try {
        const response = await handler(request, env, context);
        if (!incoming.complete) outgoing.setHeader("connection", "close");
        await sendResponse(response, outgoing, request.method, controller.signal);
      } catch {
        if (!controller.signal.aborted) console.error(JSON.stringify({ code: "http_request_failed" }));
        if (!outgoing.headersSent && !outgoing.destroyed) {
          outgoing.writeHead(500, { "content-type": "application/json", connection: "close" });
          outgoing.end('{"error":"Internal server error."}');
        } else if (!outgoing.destroyed) outgoing.destroy();
      } finally {
        // Rejecting an unfinished upload must not keep reading/buffering an
        // unbounded body or leave its socket waiting for a client that stopped.
        discardUpload();
      }
    })().finally(() => {
      incoming.off("aborted", abort);
      incoming.off("error", abort);
      incoming.off("close", incomingClosed);
      outgoing.off("close", outgoingClosed);
      controllers.delete(controller);
      requests.delete(operation);
    });
    requests.add(operation);
  });
  // The application permits five-minute generations, including quiet periods.
  server.timeout = 360_000;
  server.keepAliveTimeout = 5_000;

  function close(): Promise<{ forced: boolean }> {
    if (closed) return closed;
    closing = true;
    closed = (async () => {
      const listenerClosed = new Promise<void>((resolve) => { server.close(() => resolve()); });
      server.closeIdleConnections();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graceful = Promise.all([listenerClosed, drain()]).then(() => false);
      const forced = await Promise.race([graceful, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), grace); })]);
      if (timer) clearTimeout(timer);
      if (forced) {
        for (const controller of controllers) controller.abort(new Error("Server shutdown deadline exceeded."));
        server.closeAllConnections();
        // Let disconnect-triggered usage/slot cleanup settle, with a bounded
        // final interval even if an upstream ignores AbortSignal.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([drain(), new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, 1_000); })]);
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
      return { forced };
    })();
    return closed;
  }

  return { server, close, waitUntil, drain };
}
