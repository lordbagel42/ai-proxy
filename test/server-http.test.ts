import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApplicationServer, type ApplicationHandler, type ApplicationServerOptions } from "../server/http";
import { createStaticAssets } from "../server/assets";
import type { AppEnv } from "../src/env";
import { readJSON } from "../src/core/sse";
import { ApiError } from "../src/core/errors";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const running: ReturnType<typeof createApplicationServer>[] = [];
const directories: string[] = [];

async function start(handler?: ApplicationHandler, options: ApplicationServerOptions = {}, extraEnv: Partial<AppEnv> = {}) {
  const app = createApplicationServer({ BETTER_AUTH_URL: "https://relay.example.test", ...extraEnv } as AppEnv, { handler, shutdownGraceMs: 100, ...options });
  running.push(app);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener.");
  return { app, url: `http://127.0.0.1:${address.port}` };
}

async function rawResponse(url: string, options: { path?: string; method?: string; headers?: Record<string, string> } = {}) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(url, { ...options, agent: false }, resolve);
    request.once("error", reject);
    request.end();
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return { response, body: Buffer.concat(chunks).toString("utf8") };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Node HTTP adaptation", () => {
  it("uses the configured public origin and replaces untrusted forwarding identity with the socket peer", async () => {
    const { url } = await start((request) => Response.json({ url: request.url, headers: Object.fromEntries(request.headers) }));
    const { body } = await rawResponse(`${url}/api/session?next=admin`, { headers: {
      host: "attacker.example", "cf-connecting-ip": "198.51.100.9", "x-forwarded-host": "attacker.example", "x-forwarded-for": "198.51.100.9",
      "x-forwarded-proto": "http", forwarded: "for=198.51.100.9;host=attacker.example", "x-real-ip": "198.51.100.9", authorization: "Bearer client-token",
    } });
    const value = JSON.parse(body);
    expect(value.url).toBe("https://relay.example.test/api/session?next=admin");
    expect(value.headers.host).toBe("relay.example.test");
    expect(value.headers["cf-connecting-ip"]).toBe("127.0.0.1");
    expect(value.headers.authorization).toBe("Bearer client-token");
    for (const key of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"]) expect(value.headers[key]).toBeUndefined();
  });

  it("accepts one valid Cloudflare client IP only from an allowlisted proxy socket", async () => {
    const echo: ApplicationHandler = (request) => Response.json({ ip: request.headers.get("cf-connecting-ip") });
    const trusted = await start(echo, { trustedProxies: ["127.0.0.0/8"] });
    const good = await rawResponse(trusted.url, { headers: { "cf-connecting-ip": "2001:db8::123" } });
    expect(JSON.parse(good.body).ip).toBe("2001:db8::123");
    const invalid = await rawResponse(trusted.url, { headers: { "cf-connecting-ip": "198.51.100.1, 198.51.100.2" } });
    expect(JSON.parse(invalid.body).ip).toBe("127.0.0.1");
    const wrongPeer = await start(echo, { trustedProxies: ["192.0.2.1"] });
    expect(JSON.parse((await rawResponse(wrongPeer.url, { headers: { "cf-connecting-ip": "198.51.100.9" } })).body).ip).toBe("127.0.0.1");
    expect(() => createApplicationServer({ BETTER_AUTH_URL: "https://relay.example.test" } as AppEnv, { trustedProxies: ["0.0.0.0/99"] })).toThrow("CIDR");
  });

  it("rejects absolute-form and authority-form request targets", async () => {
    let handled = 0;
    const { url } = await start(() => { handled++; return new Response("unexpected"); });
    for (const path of ["http://attacker.example/admin", "//attacker.example/admin", "/\\attacker.example/admin"]) {
      expect((await rawResponse(url, { path })).response.statusCode).toBe(400);
    }
    expect(handled).toBe(0);
  });

  it("retains separate Set-Cookie values, status, ordinary headers, and HEAD semantics", async () => {
    const { url } = await start(() => {
      const headers = new Headers({ location: "/admin", "x-example": "present" });
      headers.append("set-cookie", "session=one; Path=/; HttpOnly; Secure");
      headers.append("set-cookie", "state=two; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/; Secure");
      return new Response("redirect body", { status: 302, headers });
    });
    const { response, body } = await rawResponse(url);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/admin");
    expect(response.headers["x-example"]).toBe("present");
    expect(response.headers["set-cookie"]).toHaveLength(2);
    expect(response.headers["set-cookie"]?.[1]).toContain("Wed, 21 Oct 2037");
    expect(body).toBe("redirect body");
    expect((await rawResponse(url, { method: "HEAD" })).body).toBe("");
  });

  it("delivers an incoming upload to the handler before the upload ends", async () => {
    const firstChunk = deferred<string>();
    const { url } = await start(async (request) => {
      const reader = request.body!.getReader();
      const initial = await reader.read();
      firstChunk.resolve(new TextDecoder().decode(initial.value));
      let text = new TextDecoder().decode(initial.value);
      for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
      return new Response(text);
    });
    const response = deferred<IncomingMessage>();
    const request = httpRequest(url, { method: "POST", agent: false }, response.resolve);
    request.write("first ");
    expect(await firstChunk.promise).toBe("first ");
    request.end("last");
    const chunks: Buffer[] = [];
    for await (const chunk of await response.promise) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("first last");
  });

  it("delivers an early upload rejection and closes the unfinished body/socket", async () => {
    const { app, url } = await start(() => new Response("rejected", { status: 413 }));
    const received = deferred<IncomingMessage>();
    const request = httpRequest(url, { method: "POST", headers: { "content-length": "100000000" }, agent: false }, received.resolve);
    const ended = once(request, "close");
    request.write("first bytes");
    const response = await received.promise;
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
    expect(response.statusCode).toBe(413);
    expect(Buffer.concat(chunks).toString()).toBe("rejected");
    expect(response.headers.connection).toBe("close");
    await ended;
    expect(await app.close()).toEqual({ forced: false });
  });

  it("delivers the complete 413 JSON when cancelling an oversized chunked upload", async () => {
    const { app, url } = await start(async (request) => {
      try { return Response.json(await readJSON(request, 10)); }
      catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return Response.json({ error: error.message }, { status: error.status });
      }
    });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers: { "content-type": "application/json" }, agent: false }, resolve);
      request.once("error", reject);
      // No Content-Length: readJSON must discover the limit by reading and
      // cancelling the Web stream while this HTTP upload is still incomplete.
      request.write('"abcdefghijklmnopqr"');
      const delayedEnd = setTimeout(() => request.end(), 100);
      request.once("close", () => clearTimeout(delayedEnd));
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
    expect(response.statusCode).toBe(413);
    expect(response.complete).toBe(true);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ error: "Request body is too large." });
    expect(response.headers.connection).toBe("close");
    expect(await app.close()).toEqual({ forced: false });
  });

  it("aborts the request and rejects a pending body read when the uploading client disconnects", async () => {
    const reading = deferred(); const aborted = deferred(); const rejected = deferred();
    const { app, url } = await start(async (request) => {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      reading.resolve();
      try { await readJSON(request); }
      catch { rejected.resolve(); }
      return new Response("finished");
    });
    const request = httpRequest(url, { method: "POST", agent: false });
    request.on("error", () => {});
    request.write('{"incomplete":');
    await reading.promise;
    request.destroy();
    await Promise.all([aborted.promise, rejected.promise]);
    expect(await app.close()).toEqual({ forced: false });
  });

  it("streams SSE promptly and cancels upstream work and tracks cleanup on disconnect", async () => {
    const aborted = deferred(); const cancelled = deferred(); const cleanup = deferred();
    let cleanupDone = false;
    const { app, url } = await start((request, _env, context) => {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
        cancel() { cancelled.resolve(); context.waitUntil(cleanup.promise.then(() => { cleanupDone = true; })); },
      }), { headers: { "content-type": "text/event-stream" } });
    }, { shutdownGraceMs: 1_000 });
    const response = await fetch(url);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    await reader.cancel();
    await Promise.all([aborted.promise, cancelled.promise]);
    let drained = false;
    const drain = app.drain().then(() => { drained = true; });
    await delay(20);
    expect(drained).toBe(false);
    cleanup.resolve();
    await drain;
    expect(cleanupDone).toBe(true);
  });

  it("applies backpressure instead of consuming an unlimited response for a paused client", async () => {
    let produced = 0;
    const chunk = new Uint8Array(64 * 1024);
    const { url } = await start(() => new Response(new ReadableStream({ pull(controller) { produced += chunk.byteLength; controller.enqueue(chunk); } })));
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(url, { agent: false }, resolve);
      request.once("error", reject);
      request.end();
    });
    response.pause();
    await delay(100);
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(16 * 1024 * 1024);
    response.destroy();
  });

  it("waits for background tasks on shutdown and enforces a deadline for live streams", async () => {
    const finished = deferred();
    const { app, url } = await start((_request, _env, context) => { context.waitUntil(finished.promise); return new Response("ok"); }, { shutdownGraceMs: 1_000 });
    expect(await (await fetch(url)).text()).toBe("ok");
    let closed = false;
    const closing = app.close().then((result) => { closed = true; return result; });
    await delay(20);
    expect(closed).toBe(false);
    finished.resolve();
    expect(await closing).toEqual({ forced: false });

    const aborted = deferred();
    const streaming = await start((request) => {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("event: ready\n\n")); } }));
    }, { shutdownGraceMs: 20 });
    const response = await fetch(streaming.url);
    const read = response.body!.getReader();
    await read.read();
    expect(await streaming.app.close()).toEqual({ forced: true });
    await aborted.promise;
    await expect(read.read()).rejects.toThrow();
    expect(streaming.app.server.timeout).toBeGreaterThanOrEqual(300_000);
  });
});

describe("public asset binding", () => {
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "ai-proxy-assets-")); directories.push(directory);
    const publicDirectory = join(directory, "public"); await mkdir(publicDirectory);
    await mkdir(join(publicDirectory, "fonts"));
    await writeFile(join(publicDirectory, "index.html"), "<main>Portal</main>");
    await writeFile(join(publicDirectory, "admin.html"), "<main>Admin</main>");
    await writeFile(join(publicDirectory, "style.css"), "body{color:white}");
    await writeFile(join(publicDirectory, "fonts", "font.woff2"), "font");
    await writeFile(join(publicDirectory, ".env"), "secret");
    await writeFile(join(directory, "private.txt"), "private");
    await symlink(join(directory, "private.txt"), join(publicDirectory, "leak.txt"));
    return { directory, publicDirectory, assets: createStaticAssets(publicDirectory) };
  }

  it("serves the actual worker routes and security headers with asset MIME and HEAD lengths", async () => {
    const { assets } = await fixture();
    const { url } = await start(undefined, {}, { ASSETS: assets });
    const health = await fetch(`${url}/health`);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("x-request-id")).toBeTruthy();
    const admin = await fetch(`${url}/admin`);
    expect(await admin.text()).toContain("Admin");
    expect(admin.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(admin.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const css = await fetch(`${url}/style.css`, { method: "HEAD" });
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("content-length")).toBe("17");
    expect(await css.text()).toBe("");
    expect((await fetch(`${url}/fonts/font.woff2`)).headers.get("content-type")).toBe("font/woff2");
  });

  it("rejects hidden files, escapes, non-public files, symlinks, and post-start additions", async () => {
    const { assets, publicDirectory } = await fixture();
    await writeFile(join(publicDirectory, "late.txt"), "not inventoried");
    for (const path of ["/.env", "/private.txt", "/%2e%2e/private.txt", "/%2e%2e%2fprivate.txt", "/..%5cprivate.txt", "/leak.txt", "/late.txt", "/fonts/", "/style.css%00"]) {
      expect((await assets.fetch(`https://relay.example.test${path}`)).status, path).toBe(404);
    }
    expect((await assets.fetch("https://relay.example.test/%zz")).status).toBe(400);
    expect((await assets.fetch("https://relay.example.test/style.css", { method: "POST" })).status).toBe(405);
    await rm(join(publicDirectory, "style.css"));
    await symlink(join(publicDirectory, "..", "private.txt"), join(publicDirectory, "style.css"));
    expect((await assets.fetch("https://relay.example.test/style.css")).status).toBe(404);
  });
});
