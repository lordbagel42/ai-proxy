import { ApiError } from "../core/errors";

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
  idToken?: string;
}

export interface DeviceLogin {
  kind?: "device";
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  /** Unix epoch milliseconds. */
  expiresAt: number;
}

export interface BrowserLogin {
  kind: "browser";
  authorizationUrl: string;
  /** Only stored encrypted; never returned by connectionStatus. */
  codeVerifier: string;
  state: string;
  expiresAt: number;
}
export type PendingLogin = DeviceLogin | BrowserLogin;

// These fixed endpoints and the public OAuth client match openai/codex:
// codex-rs/login/src/device_code_auth.rs, server.rs, auth/manager.rs.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_START = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_POLL = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const DEVICE_CALLBACK = "https://auth.openai.com/deviceauth/callback";
const BROWSER_AUTHORIZE = "https://auth.openai.com/oauth/authorize";
const BROWSER_CALLBACK = "http://localhost:1455/auth/callback";
const MAX_BODY_BYTES = 131_072;
const TIMEOUT_MS = 20_000;
const DEVICE_COMPLETION_TIMEOUT_MS = 25_000;
const MAX_DEVICE_AGE_MS = 15 * 60_000;
type ObjectValue = Record<string, unknown>;

function object(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(): ApiError {
  return new ApiError(503, "ChatGPT authentication is temporarily unavailable. Try again shortly.", "codex_auth_unavailable");
}

function reconnect(): ApiError {
  return new ApiError(503, "The ChatGPT connection expired or was revoked. Connect ChatGPT again.", "codex_reauthentication_required");
}

function expired(): ApiError {
  return new ApiError(410, "This ChatGPT login expired. Start a new connection.", "codex_login_expired");
}

function invalidCallback(): ApiError {
  return new ApiError(400, "Paste the complete localhost callback URL from this sign-in attempt.", "codex_callback_invalid");
}

function browserFailed(): ApiError {
  return new ApiError(400, "ChatGPT sign-in was not completed. Generate a new sign-in link.", "codex_login_failed");
}

function safeString(value: unknown, maxLength = 32_768): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/.test(value);
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    await response.body?.cancel().catch(() => undefined);
    throw unavailable();
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw unavailable();
      }
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { return undefined; }
}

/** No caller-selected endpoints, forwarded headers, redirects, automatic retries, or error bodies. */
async function post(url: string, body: ObjectValue | URLSearchParams, deadline?: AbortSignal): Promise<{ status: number; data: unknown }> {
  if (deadline?.aborted) throw unavailable();
  const controller = new AbortController();
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortFromDeadline: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      abortFromDeadline = () => { controller.abort(); reject(unavailable()); };
      timer = setTimeout(abortFromDeadline, TIMEOUT_MS);
      deadline?.addEventListener("abort", abortFromDeadline, { once: true });
    });
    const request = async () => {
      response = await fetch(url, {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { "content-type": body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json", accept: "application/json" },
        body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
      });
      if ((response.status >= 300 && response.status < 400) || response.headers.get("cf-mitigated") === "challenge") {
        await response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      return { status: response.status, data: await readBody(response, controller.signal) };
    };
    return await Promise.race([request(), timeout]);
  } catch (error) {
    controller.abort();
    // Fetch/JSON errors may include request metadata; never return their messages.
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortFromDeadline) deadline?.removeEventListener("abort", abortFromDeadline);
  }
}

// Claims are routing/expiry hints from the fixed HTTPS token endpoint, not a substitute
// for signature verification. ChatGPT validates the access token on inference requests.
function claims(token: string): ObjectValue | undefined {
  if (!token.includes(".")) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw unavailable();
  try {
    const raw = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "="));
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!object(value)) throw unavailable();
    return value;
  } catch { throw unavailable(); }
}

function accountClaim(value: ObjectValue | undefined): string | undefined {
  const auth = value?.["https://api.openai.com/auth"];
  if (auth === undefined) return undefined;
  if (!object(auth)) throw unavailable();
  if (auth.chatgpt_account_id === undefined) return undefined;
  if (!safeString(auth.chatgpt_account_id, 512)) throw unavailable();
  return auth.chatgpt_account_id;
}

function parseTokens(data: unknown, previous?: CodexTokens): CodexTokens {
  if (!object(data) || !safeString(data.access_token) || data.access_token.startsWith("sk-")) throw unavailable();
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  const idToken = data.id_token ?? previous?.idToken;
  if (!safeString(refreshToken) || (idToken !== undefined && !safeString(idToken))) throw unavailable();
  const accessClaims = claims(data.access_token);
  const idClaims = idToken === undefined ? undefined : claims(idToken);
  if (idToken !== undefined && !idClaims) throw unavailable();
  const accessAccount = accountClaim(accessClaims);
  const idAccount = accountClaim(idClaims);
  if (accessAccount && idAccount && accessAccount !== idAccount) throw reconnect();
  const accountId = accessAccount ?? idAccount ?? previous?.accountId;
  if (!safeString(accountId, 512)) throw unavailable();
  if (previous && previous.accountId !== accountId) throw reconnect();
  const expirations: number[] = [];
  if (data.expires_in !== undefined) {
    if (typeof data.expires_in !== "number" || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0) throw unavailable();
    expirations.push(Date.now() + data.expires_in * 1_000);
  }
  if (accessClaims?.exp !== undefined) {
    if (typeof accessClaims.exp !== "number" || !Number.isSafeInteger(accessClaims.exp)) throw unavailable();
    expirations.push(accessClaims.exp * 1_000);
  }
  const expiresAt = Math.min(...expirations);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw unavailable();
  return { accessToken: data.access_token, refreshToken, accountId, expiresAt, ...(idToken === undefined ? {} : { idToken }) };
}

export async function startDeviceLogin(): Promise<DeviceLogin> {
  const { status, data } = await post(DEVICE_START, { client_id: CLIENT_ID });
  if (status < 200 || status >= 300 || !object(data)) throw unavailable();
  const userCode = data.user_code ?? data.usercode;
  if (!safeString(data.device_auth_id, 2_048) || !safeString(userCode, 128)) throw unavailable();
  if (data.interval !== undefined && typeof data.interval !== "number" &&
    !(typeof data.interval === "string" && /^\d+$/.test(data.interval.trim()))) throw unavailable();
  const interval = data.interval === undefined ? 5 : Number(data.interval);
  if (!Number.isSafeInteger(interval) || interval < 0 || interval > 60) throw unavailable();
  return { kind: "device", deviceAuthId: data.device_auth_id, userCode, intervalSeconds: Math.max(5, interval), expiresAt: Date.now() + MAX_DEVICE_AGE_MS };
}

/** The native browser flow uses an allowlisted loopback callback, handed back manually. */
export async function startBrowserLogin(): Promise<BrowserLogin> {
  const codeVerifier = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64url");
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))).toString("base64url");
  const authorization = new URL(BROWSER_AUTHORIZE);
  authorization.search = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: BROWSER_CALLBACK,
    code_challenge: challenge, code_challenge_method: "S256", state,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs",
  }).toString();
  return { kind: "browser", authorizationUrl: authorization.toString(), codeVerifier, state, expiresAt: Date.now() + MAX_DEVICE_AGE_MS };
}

export async function completeBrowserLogin(login: BrowserLogin, callbackUrl: string): Promise<CodexTokens> {
  if (!Number.isSafeInteger(login.expiresAt) || login.expiresAt <= Date.now() || login.expiresAt > Date.now() + MAX_DEVICE_AGE_MS) throw expired();
  if (!/^[A-Za-z0-9_-]{86}$/.test(login.codeVerifier) || !/^[A-Za-z0-9_-]{43}$/.test(login.state)) throw browserFailed();
  if (typeof callbackUrl !== "string" || callbackUrl.length > 30_000 || !callbackUrl.startsWith(`${BROWSER_CALLBACK}?`) ||
    callbackUrl.includes("#") || /[\x00-\x20\x7f]/.test(callbackUrl)) throw invalidCallback();
  let callback: URL;
  try { callback = new URL(callbackUrl); } catch { throw invalidCallback(); }
  if (callback.origin !== "http://localhost:1455" || callback.pathname !== "/auth/callback" || callback.username || callback.password || callback.hash) throw invalidCallback();
  const parameters = callback.searchParams;
  if (parameters.getAll("state").length !== 1 || parameters.get("state") !== login.state) throw invalidCallback();
  for (const key of ["code", "error", "error_description"]) {
    if (parameters.getAll(key).length > 1) throw invalidCallback();
  }
  if (parameters.has("error")) {
    if (parameters.has("code") || !parameters.get("error")) throw invalidCallback();
    throw browserFailed();
  }
  if (parameters.has("error_description") || parameters.getAll("code").length !== 1) throw invalidCallback();
  const code = parameters.get("code");
  if (!safeString(code, 8_192)) throw invalidCallback();
  // Parse the pasted URL only. Never send a network request to caller input.
  const exchanged = await post(TOKEN_ENDPOINT, new URLSearchParams({
    grant_type: "authorization_code", client_id: CLIENT_ID, redirect_uri: BROWSER_CALLBACK,
    code, code_verifier: login.codeVerifier,
  }));
  if (exchanged.status >= 400 && exchanged.status < 500 && exchanged.status !== 408 && exchanged.status !== 429) throw browserFailed();
  if (exchanged.status < 200 || exchanged.status >= 300) throw unavailable();
  // A successful exchange consumes its one-time code even if token data is unusable.
  try { return parseTokens(exchanged.data); } catch { throw browserFailed(); }
}

export async function pollDeviceLogin(login: DeviceLogin): Promise<{ status: "pending" } | { status: "complete"; tokens: CodexTokens }> {
  if (!Number.isSafeInteger(login.expiresAt) || login.expiresAt <= Date.now() || login.expiresAt > Date.now() + MAX_DEVICE_AGE_MS) throw expired();
  if (!safeString(login.deviceAuthId, 2_048) || !safeString(login.userCode, 128)) throw unavailable();
  // Keep both one-time-code requests within Workers' post-disconnect waitUntil
  // window, leaving time for the caller to encrypt and commit the credentials.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DEVICE_COMPLETION_TIMEOUT_MS);
  try {
    const polled = await post(DEVICE_POLL, { device_auth_id: login.deviceAuthId, user_code: login.userCode }, deadline.signal);
    if (polled.status === 403 || polled.status === 404) return { status: "pending" };
    if (polled.status < 200 || polled.status >= 300 || !object(polled.data)) throw unavailable();
    if (!safeString(polled.data.authorization_code, 8_192) || !safeString(polled.data.code_verifier, 1_024)) throw unavailable();
    const exchanged = await post(TOKEN_ENDPOINT, new URLSearchParams({
      grant_type: "authorization_code", client_id: CLIENT_ID, redirect_uri: DEVICE_CALLBACK,
      code: polled.data.authorization_code, code_verifier: polled.data.code_verifier,
    }), deadline.signal);
    if (exchanged.status < 200 || exchanged.status >= 300) throw unavailable();
    return { status: "complete", tokens: parseTokens(exchanged.data) };
  } finally { clearTimeout(timer); }
}

export async function refreshCodexTokens(previous: CodexTokens): Promise<CodexTokens> {
  if (!safeString(previous.refreshToken) || !safeString(previous.accountId, 512)) throw reconnect();
  const { status, data } = await post(TOKEN_ENDPOINT, {
    grant_type: "refresh_token", refresh_token: previous.refreshToken, client_id: CLIENT_ID,
  });
  if (status < 200 || status >= 300) {
    const error = object(data) ? data.error : undefined;
    const code = typeof error === "string" ? error : object(error) ? error.code : undefined;
    const normalized = typeof code === "string" ? code.toLowerCase() : "";
    if (status === 401 || (status === 400 && normalized === "invalid_grant") ||
      ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "refresh_token_revoked"].includes(normalized)) throw reconnect();
    throw unavailable();
  }
  return parseTokens(data, previous);
}
