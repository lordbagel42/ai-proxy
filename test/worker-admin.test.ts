import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSignedCookie } from "better-call";
import worker from "../src/worker";
import { digest, issueKey } from "../src/access";
import type { AppEnv } from "../src/env";
import { anthropicFixture } from "./fixtures";

const appEnv: AppEnv = {
  ...env,
  BETTER_AUTH_URL: "http://localhost:8787",
  BETTER_AUTH_SECRET: "worker-admin-tests-secret-not-for-real-use-12345",
  HACKCLUB_CLIENT_ID: "test-client", HACKCLUB_CLIENT_SECRET: "test-secret",
  ALLOWED_HACKCLUB_IDS: "ident!owner,ident!friend", OWNER_HACKCLUB_ID: "ident!owner",
  RELAY_SHARED_SECRET: "test-upstream-secret", REQUESTS_PER_MINUTE: "20",
  PROVIDERS_JSON: JSON.stringify([{ id: "claude", protocol: "anthropic", baseUrl: "https://relay.test/v1", credential: "RELAY_SHARED_SECRET", models: { claude: "upstream-claude" } }]),
};
type Role = "owner" | "friend" | "newcomer" | "other";
const cookies = {} as Record<Role, string>;
let ownerKey: string;
let friendKey: string;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM proxy_invite"), env.DB.prepare("DELETE FROM proxy_member"),
    env.DB.prepare("DELETE FROM usage_event"),
    env.DB.prepare('DELETE FROM "user"'), env.DB.prepare("DELETE FROM quota"),
    env.DB.prepare("DELETE FROM cli_login"), env.DB.prepare("DELETE FROM rate_limit"), env.DB.prepare("DELETE FROM verification"),
  ]);
  const now = Date.now();
  for (const role of ["owner", "friend", "newcomer", "other"] as const) {
    await env.DB.prepare('INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .bind(`user-${role}`, `Test ${role}`, `${role}@example.com`, now, now).run();
    await env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(`account-${role}`, `ident!${role}`, "hackclub", `user-${role}`, now, now).run();
    await env.DB.prepare("INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(`session-${role}`, now + 3_600_000, `admin-session-token-${role}`, now, now, `user-${role}`).run();
    cookies[role] = (await serializeSignedCookie("better-auth.session_token", `admin-session-token-${role}`, appEnv.BETTER_AUTH_SECRET)).split(";")[0]!;
  }
  ownerKey = (await issueKey(appEnv, "user-owner", "Owner key")).key;
  friendKey = (await issueKey(appEnv, "user-friend", "Friend key")).key;
});

async function call(path: string, init: RequestInit = {}, overrides: Partial<AppEnv> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`http://localhost:8787${path}`, init), { ...appEnv, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const browserHeaders = (role: Role = "owner") => ({ cookie: cookies[role], origin: appEnv.BETTER_AUTH_URL, "content-type": "application/json" });
const keyHeaders = (key = friendKey) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
const jsonRequest = (method: string, body: unknown, role: Role = "owner") => ({ method, headers: browserHeaders(role), body: JSON.stringify(body) });
const patchMember = (identityId: string, body: unknown) => call(`/api/admin/members/${encodeURIComponent(identityId)}`, jsonRequest("PATCH", body));

interface Invite { id: string; label: string; targetIdentity: string | null; createdAt: number; expiresAt: number; status: string; acceptedBy: string | null }
interface Member { identityId: string; userId: string | null; name: string | null; email: string | null; status: string; isOwner: boolean; label: string; requestsToday: number; activeKeys: number }
interface Overview { summary: { activeMembers: number; suspendedMembers: number; pendingInvites: number; requestsToday: number; activeKeys: number }; members: Member[]; invites: Invite[]; defaults: { minuteLimit: number } }
async function createInvite(body: Record<string, unknown> = { label: "A friend" }) {
  const response = await call("/api/admin/invites", jsonRequest("POST", body));
  expect(response.status).toBe(201);
  const result = await response.json<{ invite: Invite; url: string }>();
  const url = new URL(result.url);
  expect(url.origin).toBe(appEnv.BETTER_AUTH_URL);
  expect(url.pathname).toBe("/invite");
  expect(url.search).toBe("");
  const token = url.hash.slice(1);
  expect(token).toBeTruthy();
  return { ...result, token };
}
const acceptInvite = (token: string, role: Role = "newcomer") => call("/api/invites/accept", jsonRequest("POST", { token }, role));
const overview = async () => (await call("/api/admin/overview", { headers: browserHeaders() })).json<Overview>();
const generate = (key = friendKey, overrides: Partial<AppEnv> = {}) => call("/v1/responses", { method: "POST", headers: keyHeaders(key), body: '{"model":"claude","input":"Hello"}' }, overrides);
const mockGeneration = () => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(anthropicFixture(), { headers: { "content-type": "text/event-stream" } }));

describe("owner administration authorization", () => {
  it.each([
    ["GET", "/api/admin/overview"],
    ["POST", "/api/admin/invites"],
    ["DELETE", "/api/admin/invites/not-an-invite"],
    ["PATCH", "/api/admin/members/ident!friend"],
    ["DELETE", "/api/admin/members/ident!friend/keys"],
  ])("requires an owner browser session for %s %s", async (method, path) => {
    expect((await call(path, { method, headers: browserHeaders("friend") })).status).toBe(403);
    expect((await call(path, { method, headers: { origin: appEnv.BETTER_AUTH_URL } })).status).toBe(401);
    expect((await call(path, { method, headers: { ...keyHeaders(ownerKey), origin: appEnv.BETTER_AUTH_URL } })).status).toBe(401);
  });

  it.each([
    ["POST", "/api/admin/invites"],
    ["DELETE", "/api/admin/invites/not-an-invite"],
    ["PATCH", "/api/admin/members/ident!friend"],
    ["DELETE", "/api/admin/members/ident!friend/keys"],
    ["POST", "/api/invites/accept"],
  ])("rejects cross-origin mutation for %s %s", async (method, path) => {
    expect((await call(path, { method, headers: { ...browserHeaders(), origin: "https://attacker.example" } })).status).toBe(403);
  });

  it("exposes an onboarding session without granting proxy or management access", async () => {
    expect(await (await call("/api/session", { headers: browserHeaders("newcomer") })).json())
      .toMatchObject({ user: { name: "Test newcomer", email: "newcomer@example.com" }, isOwner: false, hasAccess: false });
    expect((await call("/api/me", { headers: browserHeaders("newcomer") })).status).toBe(403);
    expect((await call("/api/keys", jsonRequest("POST", { name: "unauthorized" }, "newcomer"))).status).toBe(403);
    expect((await call("/api/admin/overview", { headers: browserHeaders("newcomer") })).status).toBe(403);
    expect(await (await call("/api/session", { headers: browserHeaders() })).json()).toMatchObject({ isOwner: true, hasAccess: true });
  });

  it("lets an unlisted Hack Club identity finish OAuth for invitation onboarding", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://auth.hackclub.com/oauth/token") return Response.json({ access_token: "test-hca-token", token_type: "Bearer", expires_in: 600 });
      if (url === "https://auth.hackclub.com/api/v1/me") return Response.json({ identity: {
        id: "ident!unlisted", primary_email: "unlisted@example.com", first_name: "Unlisted", last_name: "Visitor",
      } });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const started = await call("/api/auth/sign-in/social", {
      method: "POST", headers: { origin: appEnv.BETTER_AUTH_URL, "content-type": "application/json" },
      body: JSON.stringify({ provider: "hackclub", callbackURL: "/invite" }),
    });
    expect(started.status).toBe(200);
    const destination = new URL((await started.json<{ url: string }>()).url);
    const stateCookie = started.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const callback = await call(`/api/auth/callback/hackclub?code=onboarding-code&state=${encodeURIComponent(destination.searchParams.get("state")!)}`, { headers: { cookie: stateCookie } });
    expect(callback.status).toBe(302);
    const sessionCookie = callback.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const session = await call("/api/session", { headers: { cookie: sessionCookie } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: "unlisted@example.com" }, hasAccess: false, isOwner: false });
    expect((await call("/api/me", { headers: { cookie: sessionCookie } })).status).toBe(403);
  });
});

describe("membership invitations", () => {
  it("requires a browser login even when the invite token is valid", async () => {
    const invite = await createInvite();
    for (const headers of [{ origin: appEnv.BETTER_AUTH_URL }, { ...keyHeaders(ownerKey), origin: appEnv.BETTER_AUTH_URL }]) {
      expect((await call("/api/invites/accept", { method: "POST", headers, body: JSON.stringify({ token: invite.token }) })).status).toBe(401);
    }
    expect((await overview()).invites.find(item => item.id === invite.invite.id)?.status).toBe("pending");
  });

  it("creates a seven-day invite whose secret is hashed and only returned in the URL fragment", async () => {
    const before = Date.now();
    const created = await createInvite({ label: "Laptop club", targetIdentity: "ident!newcomer" });
    expect(created.invite).toMatchObject({ label: "Laptop club", targetIdentity: "ident!newcomer", status: "pending" });
    expect(created.invite).not.toHaveProperty("dailyLimit");
    expect(created.invite.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(created.invite.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
    const stored = await env.DB.prepare("SELECT * FROM proxy_invite WHERE id = ?").bind(created.invite.id).first();
    expect(stored).toMatchObject({ token_hash: await digest(created.token) });
    expect(JSON.stringify(stored)).not.toContain(created.token);
    const listed = await overview();
    expect(listed.invites).toContainEqual(expect.objectContaining({ id: created.invite.id, status: "pending" }));
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed.summary.pendingInvites).toBe(1);
  });

  it("activates an invited identity without adding it to the environment allowlist", async () => {
    const invite = await createInvite({ label: "New friend" });
    expect((await call("/api/me", { headers: browserHeaders("newcomer") })).status).toBe(403);
    const accepted = await acceptInvite(invite.token);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true });
    expect(await (await call("/api/session", { headers: browserHeaders("newcomer") })).json()).toMatchObject({ hasAccess: true });
    expect((await call("/api/me", { headers: browserHeaders("newcomer") })).status).toBe(200);
    const key = await call("/api/keys", jsonRequest("POST", { name: "Invited CLI" }, "newcomer"));
    expect(key.status).toBe(201);
    const issued = await key.json<{ key: string }>();
    expect((await call("/v1/models", { headers: keyHeaders(issued.key) })).status).toBe(200);
    expect((await overview()).members).toContainEqual(expect.objectContaining({ identityId: "ident!newcomer", status: "active", label: "New friend" }));
    expect((await acceptInvite(invite.token, "other")).status).toBe(400);
  });

  it("allows only one account to redeem an invite under a race", async () => {
    const invite = await createInvite();
    const results = await Promise.all([acceptInvite(invite.token, "newcomer"), acceptInvite(invite.token, "other")]);
    expect(results.map(result => result.status).sort()).toEqual([200, 400]);
    const members = await env.DB.prepare("SELECT identity_id FROM proxy_member WHERE identity_id IN ('ident!newcomer', 'ident!other')").all();
    expect(members.results).toHaveLength(1);
    const listed = (await overview()).invites.find(item => item.id === invite.invite.id)!;
    expect(listed.status).toBe("accepted");
    expect(listed.acceptedBy).toBe(members.results[0]!.identity_id);
  });

  it("does not consume a targeted invitation when the wrong identity attempts redemption", async () => {
    const invite = await createInvite({ label: "Specific friend", targetIdentity: "ident!newcomer" });
    expect((await acceptInvite(invite.token, "other")).status).toBe(403);
    expect((await overview()).invites.find(item => item.id === invite.invite.id)?.status).toBe("pending");
    expect((await acceptInvite(invite.token, "newcomer")).status).toBe(200);
  });

  it("rejects expired and revoked invitations", async () => {
    const expired = await createInvite({ label: "Expired" });
    await env.DB.prepare("UPDATE proxy_invite SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired.invite.id).run();
    expect((await acceptInvite(expired.token)).status).toBe(400);
    const revoked = await createInvite({ label: "Revoked" });
    expect((await call(`/api/admin/invites/${revoked.invite.id}`, { method: "DELETE", headers: browserHeaders() })).status).toBe(204);
    expect((await acceptInvite(revoked.token)).status).toBe(400);
    const listed = await overview();
    expect(listed.invites.find(item => item.id === expired.invite.id)?.status).toBe("expired");
    expect(listed.invites.find(item => item.id === revoked.invite.id)?.status).toBe("revoked");
    expect(listed.summary.pendingInvites).toBe(0);
  });

  it("does not let a suspended identity regain access by redeeming a fresh invite", async () => {
    const initial = await createInvite({ label: "Initial membership" });
    expect((await acceptInvite(initial.token)).status).toBe(200);
    expect((await patchMember("ident!newcomer", { status: "suspended" })).status).toBe(204);
    const invite = await createInvite();
    expect((await acceptInvite(invite.token)).status).toBe(403);
    expect((await call("/api/me", { headers: browserHeaders("newcomer") })).status).toBe(403);
    expect((await overview()).invites.find(item => item.id === invite.invite.id)?.status).toBe("pending");
    expect((await acceptInvite(invite.token, "other")).status).toBe(200);
  });

  it("does not carry a legacy invitation quota into a newly accepted membership", async () => {
    const invite = await createInvite({ label: "Legacy invitation" });
    await env.DB.prepare("UPDATE proxy_invite SET daily_limit = 1 WHERE id = ?").bind(invite.invite.id).run();
    expect((await acceptInvite(invite.token)).status).toBe(200);
    const issued = await issueKey(appEnv, "user-newcomer", "Legacy invite member");
    const upstream = mockGeneration();
    expect((await generate(issued.key)).status).toBe(200);
    expect((await generate(issued.key)).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT daily_limit FROM proxy_member WHERE identity_id = 'ident!newcomer'").first()).toEqual({ daily_limit: null });
    expect((await overview()).invites.find(item => item.id === invite.invite.id)).not.toHaveProperty("dailyLimit");
  });
});

describe("member controls", () => {
  it.each([
    ["PATCH", "/api/admin/members/%E0%A4%A"],
    ["DELETE", "/api/admin/members/%E0%A4%A/keys"],
  ])("rejects malformed percent encoding for %s %s", async (method, path) => {
    expect((await call(path, jsonRequest(method, { status: "suspended" }))).status).toBe(400);
  });

  it("cannot suspend the owner", async () => {
    expect((await patchMember("ident!owner", { status: "suspended" })).status).toBe(400);
    expect((await call("/api/admin/overview", { headers: browserHeaders() })).status).toBe(200);
    expect((await call("/v1/models", { headers: keyHeaders(ownerKey) })).status).toBe(200);
  });

  it("suspension immediately blocks sessions, API keys and new CLI approvals", async () => {
    const login = await (await call("/api/cli/start", { method: "POST" })).json<{ user_code: string }>();
    expect((await patchMember("ident!friend", { status: "suspended" })).status).toBe(204);
    expect((await call("/api/me", { headers: browserHeaders("friend") })).status).toBe(403);
    expect((await call("/v1/models", { headers: keyHeaders() })).status).toBe(403);
    expect((await call("/api/cli/approve", jsonRequest("POST", { user_code: login.user_code }, "friend"))).status).toBe(403);
    expect(await (await call("/api/session", { headers: browserHeaders("friend") })).json()).toMatchObject({ hasAccess: false });
    const listed = await overview();
    expect(listed.members).toContainEqual(expect.objectContaining({ identityId: "ident!friend", status: "suspended" }));
    expect(listed.summary.suspendedMembers).toBe(1);
  });

  it("reactivation restores otherwise-valid keys while explicitly revoked keys stay revoked", async () => {
    const revoked = await issueKey(appEnv, "user-friend", "Previously revoked");
    expect((await call(`/api/keys/${revoked.id}`, { method: "DELETE", headers: browserHeaders("friend") })).status).toBe(204);
    expect((await patchMember("ident!friend", { status: "suspended" })).status).toBe(204);
    expect((await call("/v1/models", { headers: keyHeaders() })).status).toBe(403);
    expect((await patchMember("ident!friend", { status: "active" })).status).toBe(204);
    expect((await call("/v1/models", { headers: keyHeaders() })).status).toBe(200);
    expect((await call("/v1/models", { headers: keyHeaders(revoked.key) })).status).toBe(401);
    expect((await call("/api/me", { headers: browserHeaders("friend") })).status).toBe(200);
  });

  it("requires an invite for a signed-in identity that is not already a member", async () => {
    expect((await patchMember("ident!other", { status: "active", label: "Added directly" })).status).toBe(404);
    expect((await call("/api/me", { headers: browserHeaders("other") })).status).toBe(403);
    expect((await overview()).members.some(member => member.identityId === "ident!other")).toBe(false);
  });

  it("also blocks collecting a CLI key approved before suspension", async () => {
    const login = await (await call("/api/cli/start", { method: "POST" })).json<{ user_code: string; device_code: string }>();
    expect((await call("/api/cli/approve", jsonRequest("POST", { user_code: login.user_code }, "friend"))).status).toBe(200);
    expect((await patchMember("ident!friend", { status: "suspended" })).status).toBe(204);
    expect((await call("/api/cli/poll", { method: "POST", body: JSON.stringify({ device_code: login.device_code }) })).status).toBe(403);
  });

  it("revokes all keys for one member without revoking the owner's keys", async () => {
    const second = await issueKey(appEnv, "user-friend", "Second key");
    expect((await call("/api/admin/members/ident!friend/keys", { method: "DELETE", headers: browserHeaders() })).status).toBe(204);
    expect((await call("/v1/models", { headers: keyHeaders() })).status).toBe(401);
    expect((await call("/v1/models", { headers: keyHeaders(second.key) })).status).toBe(401);
    expect((await call("/v1/models", { headers: keyHeaders(ownerKey) })).status).toBe(200);
    expect((await overview()).members.find(member => member.identityId === "ident!friend")?.activeKeys).toBe(0);
    expect((await call("/api/me", { headers: browserHeaders("friend") })).status).toBe(200);
  });

  it("ignores legacy daily limits and reports actual requests instead of old quota counters", async () => {
    const upstream = mockGeneration();
    expect((await patchMember("ident!friend", { label: "Unlimited daily requests" })).status).toBe(204);
    await env.DB.prepare("UPDATE proxy_member SET daily_limit = 1 WHERE identity_id = 'ident!friend'").run();
    const day = Math.floor(Date.now() / 86_400_000);
    await env.DB.prepare("INSERT INTO quota (bucket, window, count, expires_at) VALUES ('day:user-friend', ?, 5000, ?)")
      .bind(day, (day + 2) * 86_400_000).run();
    expect((await generate()).status).toBe(200);
    expect((await generate()).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    const listed = await overview();
    const member = listed.members.find(item => item.identityId === "ident!friend")!;
    expect(member).toMatchObject({ requestsToday: 2, label: "Unlimited daily requests" });
    expect(member).not.toHaveProperty("dailyLimit");
    expect(listed.defaults).toEqual({ minuteLimit: 20 });
    expect(listed.summary.requestsToday).toBe(2);
    const profile = await (await call("/api/me", { headers: browserHeaders("friend") })).json<{ usage: Record<string, unknown> }>();
    expect(profile.usage).toMatchObject({ requestsToday: 2 });
    expect(profile.usage).not.toHaveProperty("dailyLimit");
    expect((await env.DB.prepare("SELECT count FROM quota WHERE bucket = 'day:user-friend' AND window = ?").bind(day).first())?.count).toBe(5000);
  });

  it("retains the operational per-minute throttle", async () => {
    const upstream = mockGeneration();
    expect((await generate(friendKey, { REQUESTS_PER_MINUTE: "1" })).status).toBe(200);
    const throttled = await generate(friendKey, { REQUESTS_PER_MINUTE: "1" });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBeTruthy();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects removed daily-quota controls in member and invitation mutations", async () => {
    expect((await patchMember("ident!friend", { dailyLimit: 100 })).status).toBe(400);
    expect((await call("/api/admin/invites", jsonRequest("POST", { label: "Legacy client", dailyLimit: 100 }))).status).toBe(400);
  });
});
