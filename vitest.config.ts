import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig({
  test: { projects: [
    { test: { name: "node", include: ["test/core.test.ts", "test/responses-provider.test.ts", "test/codex-oauth.test.ts"] } },
    { plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: {
      bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") },
    } })], test: { name: "worker", include: ["test/codex-models.test.ts", "test/worker-models.test.ts", "test/worker.test.ts", "test/worker-codex.test.ts", "test/worker-admin.test.ts", "test/worker-analytics.test.ts"] } },
  ] },
});
