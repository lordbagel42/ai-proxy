import { ApiError } from "../core/errors";
import type { AppEnv } from "../env";
import { completeBrowserLogin, pollDeviceLogin, refreshCodexTokens, startBrowserLogin, startDeviceLogin, type CodexTokens, type PendingLogin } from "./oauth";
import { seal, unseal } from "./vault";

interface Connection {
  owner_identity: string;
  credentials: string | null;
  pending: string | null;
  expires_at: number | null;
  needs_reconnect: number;
  version: number;
  lock_id: string | null;
  lock_expires_at: number;
  next_poll_at: number;
}
export interface CredentialSnapshot { tokens: CodexTokens; version: number }
const busy = () => new ApiError(503, "ChatGPT is updating its connection. Try again shortly.", "codex_busy", "2");
const disconnected = () => new ApiError(503, "The owner needs to connect ChatGPT in the dashboard.", "codex_reauthentication_required");

async function read(env: AppEnv): Promise<Connection | null> {
  const row = await env.DB.prepare("SELECT * FROM codex_connection WHERE id = 'codex'").first<Connection>();
  if (row && row.owner_identity !== env.OWNER_HACKCLUB_ID) throw new ApiError(503, "ChatGPT connection ownership has changed. Reset the stored connection before reconnecting.", "configuration_error");
  return row;
}

// The lease serializes token rotation across Worker isolates. Every write is fenced
// by both lease ID and version, including after a disconnect or an expired lease.
async function locked<T>(env: AppEnv, operation: (row: Connection, lease: string) => Promise<T>): Promise<T> {
  if (!env.OWNER_HACKCLUB_ID) throw new ApiError(503, "The proxy owner is not configured.", "configuration_error");
  await env.DB.prepare("INSERT OR IGNORE INTO codex_connection (id, owner_identity, updated_at) VALUES ('codex', ?, ?)")
    .bind(env.OWNER_HACKCLUB_ID, Date.now()).run();
  await read(env);
  const lease = crypto.randomUUID();
  const row = await env.DB.prepare("UPDATE codex_connection SET lock_id = ?, lock_expires_at = ? WHERE id = 'codex' AND lock_expires_at <= ? RETURNING *")
    .bind(lease, Date.now() + 90_000, Date.now()).first<Connection>();
  if (!row) throw busy();
  try { return await operation(row, lease); }
  finally {
    await env.DB.prepare("UPDATE codex_connection SET lock_id = NULL, lock_expires_at = 0 WHERE id = 'codex' AND lock_id = ?").bind(lease).run();
  }
}

async function write(env: AppEnv, row: Connection, lease: string, values: {
  credentials: string | null; pending: string | null; expiresAt: number | null; needsReconnect: number; nextPollAt: number;
}) {
  const result = await env.DB.prepare(`UPDATE codex_connection SET credentials = ?, pending = ?, expires_at = ?, needs_reconnect = ?,
    next_poll_at = ?, updated_at = ?, version = version + 1 WHERE id = 'codex' AND version = ? AND lock_id = ? AND lock_expires_at > ?`)
    .bind(values.credentials, values.pending, values.expiresAt, values.needsReconnect, values.nextPollAt, Date.now(), row.version, lease, Date.now()).run();
  if (!result.meta.changes) throw busy();
}
function retained(row: Connection) {
  return { credentials: row.credentials, pending: row.pending, expiresAt: row.expires_at, needsReconnect: row.needs_reconnect, nextPollAt: row.next_poll_at };
}

export async function connectionStatus(env: AppEnv) {
  const row = await read(env);
  const login = row?.pending ? await unseal<PendingLogin>(env, "device", row.pending) : null;
  return {
    connected: !!row?.credentials, expiresAt: row?.expires_at ?? null, needsReconnect: !!row?.needs_reconnect,
    pending: login && login.expiresAt > Date.now() ? login.kind === "browser" ? {
      kind: "browser" as const, authorizationUrl: login.authorizationUrl, expiresAt: login.expiresAt,
    } : {
      kind: "device" as const,
      userCode: login.userCode, verificationUrl: "https://auth.openai.com/codex/device",
      expiresAt: login.expiresAt, intervalSeconds: login.intervalSeconds,
    } : null,
  };
}

export async function startConnection(env: AppEnv) {
  await locked(env, async (row, lease) => {
    if (row.pending) {
      const previous = await unseal<PendingLogin>(env, "device", row.pending);
      if (previous.kind !== "browser" && previous.expiresAt > Date.now()) return;
    }
    const login = await startDeviceLogin();
    await write(env, row, lease, { ...retained(row), pending: await seal(env, "device", login), nextPollAt: Date.now() + login.intervalSeconds * 1000 });
  });
  return connectionStatus(env);
}

export async function startBrowserConnection(env: AppEnv) {
  await locked(env, async (row, lease) => {
    const login = await startBrowserLogin();
    await write(env, row, lease, { ...retained(row), pending: await seal(env, "device", login), nextPollAt: 0 });
  });
  return connectionStatus(env);
}

export async function completeBrowserConnection(env: AppEnv, callbackUrl: string) {
  await locked(env, async (row, lease) => {
    const login = row.pending ? await unseal<PendingLogin>(env, "device", row.pending) : null;
    if (!login || login.kind !== "browser") throw new ApiError(400, "Generate a browser sign-in link before completing this connection.", "codex_callback_invalid");
    try {
      const tokens = await completeBrowserLogin(login, callbackUrl);
      await write(env, row, lease, { credentials: await seal(env, "tokens", tokens), pending: null,
        expiresAt: tokens.expiresAt, needsReconnect: 0, nextPollAt: 0 });
    } catch (error) {
      if (error instanceof ApiError && ["codex_login_failed", "codex_login_expired"].includes(error.code)) {
        await write(env, row, lease, { ...retained(row), pending: null, nextPollAt: 0 });
      }
      throw error;
    }
  });
  return connectionStatus(env);
}

export async function pollConnection(env: AppEnv) {
  try {
    await locked(env, async (row, lease) => {
      if (!row.pending) return;
      const login = await unseal<PendingLogin>(env, "device", row.pending);
      if (login.kind === "browser") return;
      if (login.expiresAt <= Date.now()) {
        await write(env, row, lease, { ...retained(row), pending: null, nextPollAt: 0 }); return;
      }
      if (row.next_poll_at > Date.now()) return;
      try {
        const result = await pollDeviceLogin(login);
        if (result.status === "pending") {
          await write(env, row, lease, { ...retained(row), nextPollAt: Date.now() + login.intervalSeconds * 1000 });
        } else {
          await write(env, row, lease, { credentials: await seal(env, "tokens", result.tokens), pending: null,
            expiresAt: result.tokens.expiresAt, needsReconnect: 0, nextPollAt: 0 });
        }
      } catch (error) {
        const permanent = error instanceof ApiError && error.code === "codex_reauthentication_required";
        await write(env, row, lease, { ...retained(row), pending: permanent ? null : row.pending, nextPollAt: Date.now() + login.intervalSeconds * 1000 });
        throw error;
      }
    });
  } catch (error) { if (!(error instanceof ApiError && error.code === "codex_busy")) throw error; }
  return connectionStatus(env);
}

export async function disconnectConnection(env: AppEnv) {
  await read(env);
  // Cancels pending poll/refresh writes immediately; they cannot restore tokens.
  await env.DB.prepare(`UPDATE codex_connection SET credentials = NULL, pending = NULL, expires_at = NULL, needs_reconnect = 0,
    next_poll_at = 0, lock_id = NULL, lock_expires_at = 0, version = version + 1, updated_at = ? WHERE id = 'codex'`).bind(Date.now()).run();
}

export async function codexCredentials(env: AppEnv, rejected?: CredentialSnapshot): Promise<CredentialSnapshot> {
  const current = await read(env);
  if (!current?.credentials || current.needs_reconnect) throw disconnected();
  const existing = await unseal<CodexTokens>(env, "tokens", current.credentials);
  if (existing.expiresAt > Date.now() + 60_000 && (!rejected || rejected.tokens.accessToken !== existing.accessToken)) {
    return { tokens: existing, version: current.version };
  }
  return locked(env, async (row, lease) => {
    if (!row.credentials || row.needs_reconnect) throw disconnected();
    const old = await unseal<CodexTokens>(env, "tokens", row.credentials);
    if (old.expiresAt > Date.now() + 60_000 && (!rejected || rejected.tokens.accessToken !== old.accessToken)) {
      return { tokens: old, version: row.version };
    }
    try {
      const tokens = await refreshCodexTokens(old);
      await write(env, row, lease, { ...retained(row), credentials: await seal(env, "tokens", tokens), expiresAt: tokens.expiresAt, needsReconnect: 0 });
      return { tokens, version: row.version + 1 };
    } catch (error) {
      if (error instanceof ApiError && error.code === "codex_reauthentication_required") {
        await write(env, row, lease, { ...retained(row), needsReconnect: 1 });
      }
      throw error;
    }
  });
}

export async function markConnectionRejected(env: AppEnv, version: number) {
  await env.DB.prepare("UPDATE codex_connection SET needs_reconnect = 1, version = version + 1 WHERE id = 'codex' AND version = ? AND lock_expires_at <= ?")
    .bind(version, Date.now()).run();
}

export async function acquireCodexSlot(env: AppEnv): Promise<() => Promise<void>> {
  const id = crypto.randomUUID(); const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO codex_request (id, expires_at) SELECT ?, ?
    WHERE (SELECT count(*) FROM codex_request WHERE expires_at > ?) < 2`).bind(id, now + 310_000, now).run();
  if (!result.meta.changes) throw new ApiError(429, "The shared ChatGPT account is busy. Try again shortly.", "rate_limit_error", "5");
  let released = false;
  let inFlight: Promise<void> | undefined;
  return () => {
    if (released) return Promise.resolve();
    inFlight ??= env.DB.prepare("DELETE FROM codex_request WHERE id = ?").bind(id).run()
      .then(() => { released = true; }).catch((error) => { inFlight = undefined; throw error; });
    return inFlight;
  };
}
