import { statSync } from "node:fs";
import { loadRuntimeConfig } from "./config";
import { createDatabase, validateDatabase } from "./sqlite";
import { createApplicationServer } from "./http";
import { createStaticAssets } from "./assets";
import { startCleanup } from "./scheduler";
import worker from "../src/worker";
import type { AppEnv } from "../src/env";

process.umask(0o077);

async function main() {
  const config = loadRuntimeConfig();
  if (!statSync(config.assetsPath).isDirectory()) throw new Error("ASSETS_PATH must be a directory");
  const db = createDatabase(config.databasePath);
  try { await validateDatabase(db, config.migrationsPath); }
  catch (error) { db.close(); throw error; }
  const env = { ...config.env, DB: db.asD1Database(), ASSETS: createStaticAssets(config.assetsPath) } as AppEnv;
  const app = createApplicationServer(env, {
    trustedProxies: config.trustedProxies, shutdownGraceMs: config.shutdownGraceMs,
    handler: async (request, env, ctx) => {
      if (new URL(request.url).pathname === "/health" && request.method === "GET") {
        try {
          await env.DB.prepare("SELECT 1").first();
          return Response.json({ status: "ok", serving: config.serving }, { headers: { "cache-control": "no-store" } });
        } catch { return Response.json({ status: "unavailable" }, { status: 503 }); }
      }
      if (!config.serving) return Response.json({ error: { message: "Gateway is in standby for migration.", type: "maintenance_error" } },
        { status: 503, headers: { "retry-after": "60", "cache-control": "no-store" } });
      return worker.fetch(request, env, ctx);
    },
  });
  const stopCleanup = config.serving
    ? startCleanup(() => worker.scheduled({} as ScheduledController, env), app.waitUntil)
    : () => {};
  let stopping = false;
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    stopCleanup();
    try {
      const { forced } = await app.close();
      db.close();
      console.log(JSON.stringify({ event: "server_stopped", forced }));
      // A forced stop may leave unrelated provider timers alive. All database
      // work has been drained to the grace deadline before ending the process.
      process.exit(forced ? 1 : exitCode);
    } catch {
      console.error(JSON.stringify({ event: "shutdown_failed" }));
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
  app.server.on("error", () => {
    console.error(JSON.stringify({ event: "server_error" }));
    void stop(1);
  });
  app.server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ event: "server_ready", port: config.port, serving: config.serving }));
  });
}

main().catch(() => {
  // SQLite errors can contain rows and SQL. Keep startup logs value-free.
  console.error(JSON.stringify({ event: "startup_failed", message: "Check secret file, runtime configuration, database migrations and permissions." }));
  process.exit(1);
});
