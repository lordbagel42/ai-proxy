import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { readdirSync, realpathSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { Readable } from "node:stream";
import type { AppEnv } from "../src/env";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain; charset=utf-8",
};

export function createStaticAssets(directory: string): AppEnv["ASSETS"] {
  const root = realpathSync(directory);
  const allowed = new Map<string, string>();
  function inventory(relative = ""): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) inventory(path);
      else if (entry.isFile() && contentTypes[extname(entry.name).toLowerCase()]) allowed.set(`/${path}`, join(root, path));
    }
  }
  inventory();
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, HEAD" } });
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url).pathname); }
      catch { return new Response("Invalid path.", { status: 400 }); }
      if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some((part) => part.startsWith("."))) return new Response("Not found.", { status: 404 });
      const path = allowed.get(pathname);
      if (!path) return new Response("Not found.", { status: 404 });
      try {
        const resolved = await realpath(path);
        if (resolved !== path || !resolved.startsWith(`${root}${sep}`)) return new Response("Not found.", { status: 404 });
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile()) { await file.close(); return new Response("Not found.", { status: 404 }); }
          const headers = { "content-type": contentTypes[extname(path).toLowerCase()]!, "content-length": String(stat.size) };
          if (request.method === "HEAD") { await file.close(); return new Response(null, { headers }); }
          const stream = file.createReadStream({ autoClose: true, signal: request.signal });
          return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 65_536, size: (chunk: Buffer) => chunk.byteLength } }) as unknown as ReadableStream<Uint8Array>, { headers });
        } catch (error) { await file.close(); throw error; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ELOOP") return new Response("Not found.", { status: 404 });
        throw error;
      }
    },
  } as AppEnv["ASSETS"];
}
