import { createAuth } from "./auth";
import { ApiError } from "./core/errors";
import type { AppEnv } from "./env";
import { identityForUser, membershipForUser } from "./membership";

export function randomToken(prefix = "ap_") {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
}
export function sameOrigin(request: Request, env: AppEnv) {
  if (request.headers.get("origin") !== new URL(env.BETTER_AUTH_URL).origin) throw new ApiError(403, "A same-origin browser request is required.", "permission_error");
}
export async function assertAllowed(env: AppEnv, userId: string) {
  const member = await membershipForUser(env, userId);
  if (member.status !== "active") throw new ApiError(403, member.status === "suspended" ? "Your proxy membership is suspended." : "Accept an invitation to access this proxy.", "permission_error");
}
export async function rawSessionUser(request: Request, env: AppEnv) {
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (!session) throw new ApiError(401, "Sign in with Hack Club to continue.", "authentication_error");
  return session.user;
}
export async function sessionUser(request: Request, env: AppEnv) {
  const user = await rawSessionUser(request, env);
  await assertAllowed(env, user.id);
  return user;
}

export async function isOwner(env: AppEnv, userId: string): Promise<boolean> {
  if (!env.OWNER_HACKCLUB_ID) return false;
  return await identityForUser(env, userId) === env.OWNER_HACKCLUB_ID;
}

export async function ownerUser(request: Request, env: AppEnv) {
  const user = await sessionUser(request, env);
  if (!await isOwner(env, user.id)) throw new ApiError(403, "Only the proxy owner can administer this proxy.", "permission_error");
  return user;
}

export async function apiUser(request: Request, env: AppEnv) {
  const bearer = request.headers.get("authorization");
  const key = bearer?.match(/^Bearer (ap_[a-f0-9]{64})$/i)?.[1] ?? request.headers.get("x-api-key");
  if (!key || !/^ap_[a-f0-9]{64}$/.test(key)) throw new ApiError(401, "A valid proxy API key is required.", "authentication_error");
  const row = await env.DB.prepare("SELECT id, user_id FROM api_key WHERE key_hash = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(await digest(key), Date.now()).first<{ id: string; user_id: string }>();
  if (!row) throw new ApiError(401, "This proxy key is invalid, expired, or revoked.", "authentication_error");
  await assertAllowed(env, row.user_id);
  return { keyId: row.id, userId: row.user_id };
}

export async function takeRateLimit(env: AppEnv, bucket: string, limit: number, seconds: number) {
  const window = Math.floor(Date.now() / (seconds * 1000));
  const row = await env.DB.prepare(`INSERT INTO quota (bucket, window, count, expires_at) VALUES (?, ?, 1, ?)
    ON CONFLICT (bucket, window) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`)
    .bind(bucket, window, (window + 2) * seconds * 1000, limit).first();
  if (!row) throw new ApiError(429, "Request limit reached. Try again later.", "rate_limit_error", String(seconds - Math.floor(Date.now() / 1000) % seconds));
}
export function configuredLimit(value: string, fallback: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
export async function takeGenerationRateLimit(env: AppEnv, userId: string) {
  await takeRateLimit(env, `minute:${userId}`, configuredLimit(env.REQUESTS_PER_MINUTE, 20), 60);
}

export async function issueKey(env: AppEnv, userId: string, name: string) {
  const token = randomToken(); const id = crypto.randomUUID(); const now = Date.now();
  const expiresAt = now + 90 * 86_400_000;
  const result = await env.DB.prepare(`INSERT INTO api_key (id, user_id, name, key_prefix, key_hash, created_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM api_key WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?) < 20`)
    .bind(id, userId, name, token.slice(0, 11), await digest(token), now, expiresAt, userId, now).run();
  if (!result.meta.changes) throw new ApiError(400, "Revoke an existing key before creating more (limit: 20).");
  return { id, key: token, name, expiresAt };
}
