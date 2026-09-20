import { ApiError } from "../core/errors";
import type { AppEnv } from "../env";

function unavailable(): never { throw new ApiError(503, "ChatGPT credential storage is unavailable.", "configuration_error"); }
async function key(env: AppEnv) {
  if (!env.CODEX_TOKEN_KEY || !/^[A-Za-z0-9_-]{43}$/.test(env.CODEX_TOKEN_KEY)) unavailable();
  const raw = Buffer.from(env.CODEX_TOKEN_KEY, "base64url");
  if (raw.length !== 32) unavailable();
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function context(env: AppEnv, purpose: string) {
  if (!env.OWNER_HACKCLUB_ID) unavailable();
  return new TextEncoder().encode(`friends-ai-proxy:codex:v1:${env.OWNER_HACKCLUB_ID}:${purpose}`);
}
export async function seal(env: AppEnv, purpose: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context(env, purpose) },
    await key(env), new TextEncoder().encode(JSON.stringify(value)));
  return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
}
export async function unseal<T>(env: AppEnv, purpose: string, value: string): Promise<T> {
  try {
    const [version, nonce, data, extra] = value.split(".");
    if (version !== "v1" || !nonce || !data || extra || value.length > 262_144) unavailable();
    const iv = Buffer.from(nonce, "base64url");
    if (iv.length !== 12) unavailable();
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: context(env, purpose) },
      await key(env), Buffer.from(data, "base64url"));
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch { unavailable(); }
}
