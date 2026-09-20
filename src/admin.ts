import { z } from "zod";
import { configuredLimit, digest, randomToken } from "./access";
import { ApiError } from "./core/errors";
import type { AppEnv } from "./env";
import { capacityCondition, environmentMembers, identityForUser, MAX_MEMBERS, membershipForIdentity, type MemberRow } from "./membership";

const identitySchema = z.string().trim().regex(/^ident![A-Za-z0-9_-]{1,128}$/);
const inviteInput = z.object({
  label: z.string().trim().min(1).max(120), targetIdentity: identitySchema.optional(),
  maxUses: z.number().int().min(1).max(MAX_MEMBERS).nullable().default(1),
}).strict();
const memberInput = z.object({ status: z.enum(["active", "suspended"]).optional(), label: z.string().trim().max(120).optional() }).strict();
const inviteColumns = "id, label, target_identity, created_at, expires_at, redeemed_identity, redeemed_at, revoked_at, max_uses, use_count";
const availableInvite = "revoked_at IS NULL AND expires_at > ? AND (max_uses IS NULL OR use_count < max_uses)";
interface InviteRow {
  id: string; label: string; target_identity: string | null;
  created_at: number; expires_at: number; redeemed_identity: string | null; redeemed_at: number | null; revoked_at: number | null;
  max_uses: number | null; use_count: number;
}
interface UserStats {
  identity_id: string; user_id: string; name: string; email: string; joined_at: number;
  requests_today: number; active_keys: number; last_active_at: number | null;
}

function invalid(message: string): never { throw new ApiError(400, message); }
function parseIdentity(value: string): string {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) invalid("Enter a valid Hack Club identity ID.");
  return parsed.data;
}
function inviteView(row: InviteRow) {
  return {
    id: row.id, label: row.label, targetIdentity: row.target_identity,
    createdAt: row.created_at, expiresAt: row.expires_at,
    status: row.revoked_at !== null ? "revoked" as const
      : row.max_uses !== null && row.use_count >= row.max_uses ? (row.max_uses === 1 ? "accepted" as const : "exhausted" as const)
      : row.expires_at <= Date.now() ? "expired" as const : "pending" as const,
    acceptedBy: row.redeemed_identity,
    maxUses: row.max_uses, useCount: row.use_count,
    remainingUses: row.max_uses === null ? null : Math.max(0, row.max_uses - row.use_count),
  };
}

export async function listMembers(env: AppEnv) {
  const result = await env.DB.prepare("SELECT * FROM proxy_member ORDER BY created_at LIMIT ?").bind(MAX_MEMBERS + 1).all<MemberRow>();
  const rows = new Map(result.results.map(row => [row.identity_id, row]));
  const identities = new Set([...environmentMembers(env), ...rows.keys()]);
  if (identities.size > MAX_MEMBERS) throw new ApiError(503, "The member list exceeds the supported limit.", "configuration_error");
  const stats = new Map<string, UserStats>();
  const ids = [...identities];
  const now = Date.now();
  // D1 limits bound parameters; chunks keep large circles below that limit.
  for (let index = 0; index < ids.length; index += 80) {
    const chunk = ids.slice(index, index + 80);
    const users = await env.DB.prepare(`SELECT a.account_id AS identity_id, u.id AS user_id, u.name, u.email, u.created_at AS joined_at,
      (SELECT count(*) FROM usage_event WHERE user_id = u.id AND started_at >= ?) AS requests_today,
      (SELECT count(*) FROM api_key WHERE user_id = u.id AND revoked_at IS NULL AND expires_at > ?) AS active_keys,
      (SELECT max(last_used_at) FROM api_key WHERE user_id = u.id) AS last_active_at
      FROM account a JOIN "user" u ON u.id = a.user_id WHERE a.provider_id = 'hackclub' AND a.account_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(Math.floor(now / 86_400_000) * 86_400_000, now, ...chunk).all<UserStats>();
    for (const row of users.results) stats.set(row.identity_id, row);
  }
  return ids.map(identityId => {
    const row = rows.get(identityId); const user = stats.get(identityId);
    const isOwner = identityId === env.OWNER_HACKCLUB_ID;
    return {
      identityId, userId: user?.user_id ?? null, name: user?.name ?? null, email: user?.email ?? null,
      status: isOwner ? "active" as const : row?.status ?? "active" as const, isOwner,
      label: row?.label ?? "",
      requestsToday: user?.requests_today ?? 0, activeKeys: user?.active_keys ?? 0,
      lastActiveAt: user?.last_active_at ?? null, joinedAt: row?.created_at ?? user?.joined_at ?? null,
    };
  }).sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || (a.name || a.label || a.identityId).localeCompare(b.name || b.label || b.identityId));
}

export async function listInvites(env: AppEnv) {
  // Keep pending invitations visible first while bounding historical metadata.
  const result = await env.DB.prepare(`SELECT ${inviteColumns} FROM proxy_invite ORDER BY
    CASE WHEN ${availableInvite} THEN 0 ELSE 1 END, created_at DESC LIMIT 500`)
    .bind(Date.now()).all<InviteRow>();
  return result.results.map(inviteView);
}

export async function getAdminOverview(env: AppEnv) {
  const [members, invites] = await Promise.all([listMembers(env), listInvites(env)]);
  return {
    summary: {
      activeMembers: members.filter(member => member.status === "active").length,
      suspendedMembers: members.filter(member => member.status === "suspended").length,
      pendingInvites: invites.filter(invite => invite.status === "pending").length,
      requestsToday: members.reduce((sum, member) => sum + member.requestsToday, 0),
      activeKeys: members.reduce((sum, member) => sum + member.activeKeys, 0),
    }, members, invites,
    defaults: { minuteLimit: configuredLimit(env.REQUESTS_PER_MINUTE, 20) },
  };
}

export async function createInvite(env: AppEnv, ownerUserId: string, body: Record<string, unknown>) {
  if (!env.OWNER_HACKCLUB_ID || await identityForUser(env, ownerUserId) !== env.OWNER_HACKCLUB_ID) {
    throw new ApiError(403, "Only the proxy owner can invite members.", "permission_error");
  }
  const parsed = inviteInput.safeParse(body);
  if (!parsed.success) invalid(`Provide an invitation label, an optional Hack Club identity, and a use limit from 1 to ${MAX_MEMBERS} (or null for unlimited uses).`);
  const input = parsed.data;
  const token = randomToken("inv_"); const now = Date.now(); const id = crypto.randomUUID();
  const row: InviteRow = {
    id, label: input.label, target_identity: input.targetIdentity ?? null,
    created_at: now, expires_at: now + 7 * 86_400_000, redeemed_identity: null, redeemed_at: null, revoked_at: null,
    max_uses: input.maxUses, use_count: 0,
  };
  const result = await env.DB.prepare(`INSERT INTO proxy_invite (id, token_hash, label, target_identity, created_at, expires_at, created_by, max_uses)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM proxy_invite WHERE ${availableInvite}) < 500`)
    .bind(id, await digest(token), row.label, row.target_identity, now, row.expires_at, ownerUserId, input.maxUses, now).run();
  if (!result.meta.changes) invalid("Revoke an unused invitation before creating more.");
  return { invite: inviteView(row), url: new URL(`/invite#${token}`, env.BETTER_AUTH_URL).toString() };
}

export async function revokeInvite(env: AppEnv, id: string): Promise<void> {
  if (!z.uuid().safeParse(id).success) invalid("Invalid invitation ID.");
  await env.DB.prepare("UPDATE proxy_invite SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(Date.now(), id).run();
}

export async function upsertMember(env: AppEnv, identityId: string, body: Record<string, unknown>): Promise<void> {
  identityId = parseIdentity(identityId);
  const parsed = memberInput.safeParse(body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) invalid("Provide a member status or label.");
  const input = parsed.data;
  if (identityId === env.OWNER_HACKCLUB_ID && input.status !== undefined) invalid("The owner's membership status cannot be changed.");
  const existing = await membershipForIdentity(env, identityId);
  // PATCH edits an existing member; invitations are the only self-service way to
  // add a new identity, avoiding accidental access from a mistyped identity.
  if (existing.status === "pending") throw new ApiError(404, "Member not found.", "not_found_error");
  const capacity = capacityCondition(env, identityId);
  const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO proxy_member (identity_id, status, label, created_at, updated_at)
    SELECT ?, ?, ?, ?, ? WHERE ${capacity.sql}
    ON CONFLICT(identity_id) DO UPDATE SET
      status = CASE WHEN ? THEN excluded.status ELSE proxy_member.status END,
      label = CASE WHEN ? THEN excluded.label ELSE proxy_member.label END, updated_at = excluded.updated_at`)
    .bind(identityId, input.status ?? existing.status, input.label ?? existing.label, now, now, ...capacity.bindings,
      input.status !== undefined ? 1 : 0, input.label !== undefined ? 1 : 0).run();
  if (!result.meta.changes) invalid("This proxy has reached its member limit.");
}

export async function revokeMemberKeys(env: AppEnv, identityId: string): Promise<void> {
  identityId = parseIdentity(identityId);
  if ((await membershipForIdentity(env, identityId)).status === "pending") throw new ApiError(404, "Member not found.", "not_found_error");
  await env.DB.prepare(`UPDATE api_key SET revoked_at = ? WHERE revoked_at IS NULL AND user_id IN
    (SELECT user_id FROM account WHERE provider_id = 'hackclub' AND account_id = ?)`)
    .bind(Date.now(), identityId).run();
}

export async function acceptInvite(env: AppEnv, userId: string, token: string): Promise<void> {
  if (!/^inv_[a-f0-9]{64}$/.test(token)) invalid("This invitation is invalid or no longer available.");
  const identityId = await identityForUser(env, userId);
  const member = await membershipForIdentity(env, identityId);
  if (member.status === "suspended") throw new ApiError(403, "Your membership is suspended. Ask the owner to restore access.", "permission_error");
  const tokenHash = await digest(token);
  const invite = await env.DB.prepare(`SELECT ${inviteColumns} FROM proxy_invite WHERE token_hash = ?`).bind(tokenHash).first<InviteRow>();
  const now = Date.now();
  if (!invite || invite.revoked_at !== null || invite.expires_at <= now) invalid("This invitation is invalid or no longer available.");
  if (invite.target_identity !== null && invite.target_identity !== identityId) throw new ApiError(403, "This invitation is for a different Hack Club identity.", "permission_error");
  // Existing members and retries never spend an invitation's remaining uses.
  if (member.status === "active") return;
  if (invite.max_uses !== null && invite.use_count >= invite.max_uses) invalid("This invitation has reached its use limit.");
  const capacity = capacityCondition(env, identityId);
  const redemption = crypto.randomUUID();
  // The transactional batch atomically reserves a use and creates membership.
  // Rechecking membership in the UPDATE prevents concurrent retries from spending
  // extra uses. The unique marker ties the INSERT to this successful reservation.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE proxy_invite SET use_count = use_count + 1, redeemed_identity = ?, redeemed_at = ?, redemption_id = ?
      WHERE token_hash = ? AND ${availableInvite}
      AND (target_identity IS NULL OR target_identity = ?)
      AND NOT EXISTS (SELECT 1 FROM proxy_member WHERE identity_id = ?)
      AND ${capacity.sql}`)
      .bind(identityId, now, redemption, tokenHash, now, identityId, identityId, ...capacity.bindings),
    env.DB.prepare(`INSERT INTO proxy_member (identity_id, status, label, created_at, updated_at)
      SELECT ?, 'active', label, ?, ? FROM proxy_invite WHERE redemption_id = ? AND token_hash = ?`)
      .bind(identityId, now, now, redemption, tokenHash),
  ]);
  if (results[0]?.meta.changes && results[1]?.meta.changes) return;
  if ((await membershipForIdentity(env, identityId)).status === "active") return;
  invalid("This invitation is no longer available or the proxy has reached its member limit.");
}
