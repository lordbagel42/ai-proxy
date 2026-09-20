import { assertAllowed, digest, randomToken, sameOrigin, sessionUser, takeRateLimit } from "./access";
import { ApiError } from "./core/errors";
import { object, string } from "./core/input";
import { readJSON } from "./core/sse";
import type { AppEnv } from "./env";

export async function startLogin(request: Request, env: AppEnv) {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  await takeRateLimit(env, `login:${await digest(ip)}`, 20, 3600);
  const deviceCode = randomToken("dc_");
  const token = `ap_${deviceCode.slice(3)}`;
  const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), (n) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[n & 31]).join("");
  const userCode = `${code.slice(0, 5)}-${code.slice(5)}`;
  await env.DB.prepare("INSERT INTO cli_login (device_hash, user_code, key_hash, key_prefix, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await digest(deviceCode), userCode, await digest(token), token.slice(0, 11), Date.now() + 600_000).run();
  return Response.json({ device_code: deviceCode, user_code: userCode, expires_in: 600, interval: 2,
    verification_uri: `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/connect`,
    verification_uri_complete: `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/connect?code=${userCode}` });
}

export async function approveLogin(request: Request, env: AppEnv) {
  sameOrigin(request, env);
  const user = await sessionUser(request, env);
  await takeRateLimit(env, `approve:${user.id}`, 20, 60);
  const body = object(await readJSON(request, 2048));
  const code = string(body.user_code).toUpperCase().trim();
  if (!/^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(code)) throw new ApiError(400, "Enter the code shown in your terminal.");
  const keyId = crypto.randomUUID(); const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE cli_login SET approved_user = ?, key_id = ? WHERE user_code = ? AND expires_at > ? AND approved_user IS NULL
      AND (SELECT count(*) FROM api_key WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?) < 20`)
      .bind(user.id, keyId, code, now, user.id, now),
    env.DB.prepare(`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at, expires_at)
      SELECT key_id, approved_user, 'CLI login', key_hash, key_prefix, ?, ? FROM cli_login WHERE user_code = ? AND key_id = ? AND approved_user = ?`)
      .bind(now, now + 90 * 86_400_000, code, keyId, user.id),
  ]);
  if (!results[0]?.meta.changes) throw new ApiError(400, "That code expired, was already used, or your account has 20 active keys.");
  return Response.json({ approved: true });
}

export async function pollLogin(request: Request, env: AppEnv) {
  const body = object(await readJSON(request, 2048));
  const code = string(body.device_code);
  if (!/^dc_[a-f0-9]{64}$/.test(code)) throw new ApiError(400, "Invalid device code.");
  const hash = await digest(code);
  const row = await env.DB.prepare("SELECT approved_user, expires_at FROM cli_login WHERE device_hash = ?")
    .bind(hash).first<{ approved_user: string | null; expires_at: number }>();
  if (!row || row.expires_at <= Date.now()) throw new ApiError(400, "Login expired or was already completed.", "expired_token");
  await takeRateLimit(env, `poll:${hash}`, 35, 60);
  if (!row.approved_user) return Response.json({ status: "pending" }, { status: 202 });
  await assertAllowed(env, row.approved_user);
  const consumed = await env.DB.prepare("DELETE FROM cli_login WHERE device_hash = ? AND approved_user IS NOT NULL RETURNING key_id").bind(hash).first<{ key_id: string }>();
  if (!consumed) throw new ApiError(400, "Login was already completed.", "expired_token");
  return Response.json({ status: "approved", key: `ap_${code.slice(3)}`, key_id: consumed.key_id });
}
