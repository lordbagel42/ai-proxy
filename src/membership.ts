import { allowedIdentities } from "./auth-options";
import { ApiError } from "./core/errors";
import type { AppEnv } from "./env";

export const MAX_MEMBERS = 500;
export interface Membership {
  identityId: string;
  status: "active" | "suspended" | "pending";
  isOwner: boolean;
  label: string;
}
export interface MemberRow {
  identity_id: string;
  status: "active" | "suspended";
  label: string;
  created_at: number;
  updated_at: number;
}

export function environmentMembers(env: AppEnv): Set<string> {
  const identities = allowedIdentities(env.ALLOWED_HACKCLUB_IDS);
  if (env.OWNER_HACKCLUB_ID) identities.add(env.OWNER_HACKCLUB_ID);
  if (identities.size > MAX_MEMBERS) throw new ApiError(503, "The configured member list exceeds the supported limit.", "configuration_error");
  return identities;
}

export async function identityForUser(env: AppEnv, userId: string): Promise<string> {
  const result = await env.DB.prepare("SELECT account_id FROM account WHERE user_id = ? AND provider_id = 'hackclub' LIMIT 2")
    .bind(userId).all<{ account_id: string }>();
  if (result.results.length !== 1 || !result.results[0]?.account_id) {
    throw new ApiError(403, "A Hack Club identity is required for this proxy.", "permission_error");
  }
  return result.results[0].account_id;
}

export async function membershipForIdentity(env: AppEnv, identityId: string): Promise<Membership> {
  const row = await env.DB.prepare("SELECT * FROM proxy_member WHERE identity_id = ?").bind(identityId).first<MemberRow>();
  const isOwner = !!env.OWNER_HACKCLUB_ID && identityId === env.OWNER_HACKCLUB_ID;
  return {
    identityId, isOwner, status: isOwner ? "active" : row?.status ?? (environmentMembers(env).has(identityId) ? "active" : "pending"),
    label: row?.label ?? "",
  };
}

export async function membershipForUser(env: AppEnv, userId: string): Promise<Membership> {
  return membershipForIdentity(env, await identityForUser(env, userId));
}

/** SQL expression and bindings for a serialized INSERT/UPDATE membership cap. */
export function capacityCondition(env: AppEnv, identityId: string): { sql: string; bindings: (string | number)[] } {
  const fallback = [...environmentMembers(env)];
  if (fallback.includes(identityId)) return { sql: "1 = 1", bindings: [] };
  return {
    sql: "(EXISTS (SELECT 1 FROM proxy_member WHERE identity_id = ?) OR (SELECT count(*) FROM proxy_member WHERE identity_id NOT IN (SELECT value FROM json_each(?))) < ?)",
    bindings: [identityId, JSON.stringify(fallback), MAX_MEMBERS - fallback.length],
  };
}
