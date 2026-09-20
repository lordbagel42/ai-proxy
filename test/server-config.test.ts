import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig, parseRuntimeConfig } from "../server/config";
import { nextCleanupAt, startCleanup } from "../server/scheduler";

const config = { BETTER_AUTH_URL: "https://relay.example.com", BETTER_AUTH_SECRET: "test-secret".repeat(4),
  HACKCLUB_CLIENT_ID: "fixture", HACKCLUB_CLIENT_SECRET: "fixture", OWNER_HACKCLUB_ID: "ident!test",
  CODEX_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64url") };
afterEach(() => vi.useRealTimers());

describe("server configuration", () => {
  it("preserves credentials and restricts the configured origin", () => {
    const runtime = parseRuntimeConfig(config);
    expect(runtime.env.CODEX_TOKEN_KEY).toBe(config.CODEX_TOKEN_KEY);
    expect(runtime.port).toBe(3000);
    expect(runtime.env.ALLOWED_HACKCLUB_IDS).toBe("ident!test");
    expect(() => parseRuntimeConfig({ ...config, BETTER_AUTH_URL: "https://relay.example.com/wrong" })).toThrow(/origin/);
    expect(() => parseRuntimeConfig({ ...config, CODEX_TOKEN_KEY: "replacement" })).toThrow(/existing/);
    expect(() => parseRuntimeConfig({ ...config, BETTER_AUTH_SECRET: "" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(parseRuntimeConfig({ ...config, AI_PROXY_SERVING_ENABLED: "false" }).serving).toBe(false);
  });
  it("reads a restricted mounted dotenv file without evaluating it; explicit env wins", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-proxy-env-"));
    try {
      const path = join(directory, "secrets.env");
      writeFileSync(path, Object.entries(config).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
      expect(loadRuntimeConfig({ AI_PROXY_ENV_FILE: path, PORT: "3456" }).port).toBe(3456);
      const unsafe = join(directory, "unsafe.env");
      writeFileSync(unsafe, "SECRET=not-for-logs", { mode: 0o644 });
      expect(() => loadRuntimeConfig({ AI_PROXY_ENV_FILE: unsafe })).toThrow(/restricted secret file/);
      expect(() => loadRuntimeConfig({ AI_PROXY_ENV_FILE: "missing" })).toThrow(/restricted secret file/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("daily cleanup", () => {
  it("schedules the next 03:17 UTC across day boundaries", () => {
    expect(nextCleanupAt(Date.parse("2026-09-19T03:16:00Z"))).toBe(Date.parse("2026-09-19T03:17:00Z"));
    expect(nextCleanupAt(Date.parse("2026-09-19T03:17:00Z"))).toBe(Date.parse("2026-09-20T03:17:00Z"));
  });
  it("registers cleanup as background work, does not overlap, and stops rescheduling", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-19T03:16:59Z"));
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const tasks: Promise<unknown>[] = [];
    const stop = startCleanup(run, (task) => tasks.push(task));
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1); expect(tasks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(86400000);
    expect(run).toHaveBeenCalledTimes(1);
    stop(); finish(); await Promise.all(tasks);
    await vi.advanceTimersByTimeAsync(86400000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
