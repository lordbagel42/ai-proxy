import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { AppEnv } from "../src/env";
import { configuredProviders } from "../src/providers";

type Variables = Record<string, string | undefined>;
export type RuntimeConfig = ReturnType<typeof parseRuntimeConfig>;

function required(vars: Variables, name: string): string {
  const value = vars[name];
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value;
}

function integer(vars: Variables, name: string, fallback: number, min: number, max: number): number {
  const value = vars[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}`);
  return Number(value);
}

export function parseRuntimeConfig(vars: Variables) {
  const baseURL = required(vars, "BETTER_AUTH_URL");
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error("Invalid BETTER_AUTH_URL"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin (HTTP is allowed on loopback)");
  }
  const secret = required(vars, "BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const owner = required(vars, "OWNER_HACKCLUB_ID");
  const providers = vars.PROVIDERS_JSON ?? '[{"id":"codex","protocol":"codex","discoverModels":true,"models":{}}]';
  const definitions = configuredProviders(providers);
  if (!definitions.length) throw new Error("PROVIDERS_JSON must configure at least one provider");
  const env: Omit<AppEnv, "DB" | "ASSETS"> & Record<string, unknown> = {
    BETTER_AUTH_URL: url.origin,
    BETTER_AUTH_SECRET: secret,
    HACKCLUB_CLIENT_ID: required(vars, "HACKCLUB_CLIENT_ID"),
    HACKCLUB_CLIENT_SECRET: required(vars, "HACKCLUB_CLIENT_SECRET"),
    OWNER_HACKCLUB_ID: owner,
    ALLOWED_HACKCLUB_IDS: vars.ALLOWED_HACKCLUB_IDS ?? owner,
    REQUESTS_PER_MINUTE: String(integer(vars, "REQUESTS_PER_MINUTE", 20, 1, 100000)),
    PROVIDERS_JSON: providers,
  };
  for (const provider of definitions) {
    if (provider.protocol !== "codex") env[provider.credential] = required(vars, provider.credential);
    else {
      const key = required(vars, "CODEX_TOKEN_KEY");
      // Match the existing vault's unpadded base64url encoding exactly.
      if (!/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, "base64url").length !== 32) {
        throw new Error("CODEX_TOKEN_KEY must be the existing base64url-encoded 32-byte key");
      }
      env.CODEX_TOKEN_KEY = key;
    }
  }
  const serving = vars.AI_PROXY_SERVING_ENABLED ?? "true";
  if (serving !== "true" && serving !== "false") throw new Error("AI_PROXY_SERVING_ENABLED must be true or false");
  return {
    env,
    databasePath: resolve(vars.DATABASE_PATH ?? "/data/ai-proxy.sqlite"),
    assetsPath: resolve(vars.ASSETS_PATH ?? "public"),
    migrationsPath: resolve(vars.MIGRATIONS_PATH ?? "migrations"),
    host: vars.HOST ?? "0.0.0.0",
    port: integer(vars, "PORT", 3000, 1, 65535),
    trustedProxies: (vars.TRUSTED_PROXY_IPS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    shutdownGraceMs: integer(vars, "SHUTDOWN_GRACE_MS", 30000, 1000, 300000),
    serving: serving === "true",
  };
}

export function loadRuntimeConfig(vars: Variables = process.env): RuntimeConfig {
  const filename = vars.AI_PROXY_ENV_FILE ?? "/run/secrets/ai-proxy.env";
  let file: Variables;
  try {
    const info = statSync(filename);
    if (!info.isFile() || (info.mode & 0o007) !== 0) throw new Error("permissions");
    file = parseEnv(readFileSync(filename, "utf8"));
  } catch {
    // Do not include file content, parser errors, or secret values in startup logs.
    throw new Error("Cannot read restricted secret file; check AI_PROXY_ENV_FILE and permissions (0400, 0440, or 0600)");
  }
  const overrides = Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== undefined));
  return parseRuntimeConfig({ ...file, ...overrides });
}
