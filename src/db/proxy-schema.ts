import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { user } from "./schema";

export const apiKey = sqliteTable("api_key", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(), keyPrefix: text("key_prefix").notNull(), keyHash: text("key_hash").notNull(),
  createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"), lastUsedAt: integer("last_used_at"),
}, (t) => [uniqueIndex("api_key_hash").on(t.keyHash), index("api_key_user").on(t.userId)]);

export const quota = sqliteTable("quota", {
  bucket: text("bucket").notNull(), window: integer("window").notNull(), count: integer("count").notNull(), expiresAt: integer("expires_at").notNull(),
}, (t) => [primaryKey({ columns: [t.bucket, t.window] }), index("quota_expiry").on(t.expiresAt)]);

export const cliLogin = sqliteTable("cli_login", {
  deviceHash: text("device_hash").primaryKey(), userCode: text("user_code").notNull(),
  keyHash: text("key_hash").notNull(), keyPrefix: text("key_prefix").notNull(), expiresAt: integer("expires_at").notNull(),
  approvedUser: text("approved_user").references(() => user.id, { onDelete: "cascade" }), keyId: text("key_id"),
}, (t) => [uniqueIndex("cli_login_code").on(t.userCode), index("cli_login_expiry").on(t.expiresAt)]);

export const codexConnection = sqliteTable("codex_connection", {
  id: text("id").primaryKey(), ownerIdentity: text("owner_identity").notNull(),
  credentials: text("credentials"), pending: text("pending"), expiresAt: integer("expires_at"),
  needsReconnect: integer("needs_reconnect").notNull().default(0), version: integer("version").notNull().default(0),
  lockId: text("lock_id"), lockExpiresAt: integer("lock_expires_at").notNull().default(0),
  nextPollAt: integer("next_poll_at").notNull().default(0), updatedAt: integer("updated_at").notNull(),
});
export const codexRequest = sqliteTable("codex_request", {
  id: text("id").primaryKey(), expiresAt: integer("expires_at").notNull(),
}, (t) => [index("codex_request_expiry").on(t.expiresAt)]);

export const codexModelCache = sqliteTable("codex_model_cache", {
  id: text("id").primaryKey(), ownerIdentity: text("owner_identity").notNull(),
  connectionVersion: integer("connection_version").notNull(), catalog: text("catalog").notNull(),
  fetchedAt: integer("fetched_at").notNull(), expiresAt: integer("expires_at").notNull(),
});

export const proxyMember = sqliteTable("proxy_member", {
  identityId: text("identity_id").primaryKey(), status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  label: text("label").notNull().default(""), dailyLimit: integer("daily_limit"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
});

export const proxyInvite = sqliteTable("proxy_invite", {
  id: text("id").primaryKey(), tokenHash: text("token_hash").notNull(), label: text("label").notNull(),
  targetIdentity: text("target_identity"), dailyLimit: integer("daily_limit"),
  expiresAt: integer("expires_at").notNull(), createdAt: integer("created_at").notNull(), createdBy: text("created_by").notNull(),
  redeemedIdentity: text("redeemed_identity"), redeemedAt: integer("redeemed_at"), revokedAt: integer("revoked_at"), redemptionId: text("redemption_id"),
}, (t) => [uniqueIndex("proxy_invite_token_hash").on(t.tokenHash), index("proxy_invite_expiry").on(t.expiresAt)]);

// Aggregate metadata only: never persist prompts, generated content, or tool arguments.
export const usageEvent = sqliteTable("usage_event", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  model: text("model").notNull(), provider: text("provider").notNull(), protocol: text("protocol").notNull(),
  startedAt: integer("started_at").notNull(), durationMs: integer("duration_ms").notNull().default(0),
  status: text("status", { enum: ["running", "success", "error", "cancelled"] }).notNull().default("running"),
  inputTokens: integer("input_tokens").notNull().default(0), outputTokens: integer("output_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0), toolCalls: integer("tool_calls").notNull().default(0),
}, (t) => [index("usage_event_started").on(t.startedAt), index("usage_event_user_started").on(t.userId, t.startedAt)]);
