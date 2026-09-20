import { afterEach, describe, expect, it, vi } from "vitest";
import { completeBrowserLogin, pollDeviceLogin, refreshCodexTokens, startBrowserLogin, startDeviceLogin, type BrowserLogin, type CodexTokens, type DeviceLogin } from "../src/codex/oauth";

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const tokenUrl = "https://auth.openai.com/oauth/token";
const authClaim = (id = "test-account") => ({ "https://api.openai.com/auth": { chatgpt_account_id: id } });
const jwt = (payload: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const access = (extra: Record<string, unknown> = {}) => jwt({ ...authClaim(), exp: Math.floor(Date.now() / 1_000) + 3_600, ...extra });
const tokenResponse = (extra: Record<string, unknown> = {}) => ({ access_token: access(), refresh_token: "refresh-secret", id_token: jwt(authClaim()), ...extra });
const login = (): DeviceLogin => ({ deviceAuthId: "device-id", userCode: "ABCD-EFGHI", intervalSeconds: 5, expiresAt: Date.now() + 60_000 });
const previous = (): CodexTokens => ({ accessToken: access(), refreshToken: "previous-refresh", accountId: "test-account", idToken: jwt(authClaim()), expiresAt: Date.now() + 30_000 });
const json = (data: unknown, status = 200) => Response.json(data, { status });
const mockFetch = (...responses: Response[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const browserCallback = (login: BrowserLogin, extra: Record<string, string> = {}) =>
  `http://localhost:1455/auth/callback?${new URLSearchParams({ code: "test-code", state: login.state, ...extra })}`;

describe("Worker Codex browser authentication", () => {
  it("generates the native authorization URL with unique PKCE and state without contacting OpenAI", async () => {
    const fetcher = mockFetch();
    const started = Date.now();
    const login = await startBrowserLogin();
    const url = new URL(login.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(login.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(login.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(login.codeVerifier))).toString("base64url");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code", client_id: clientId, redirect_uri: "http://localhost:1455/auth/callback",
      code_challenge: challenge, code_challenge_method: "S256", state: login.state,
      scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
      id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs",
    });
    expect(login.authorizationUrl).not.toContain(login.codeVerifier);
    expect(login.expiresAt).toBeGreaterThanOrEqual(started + 900_000);
    expect(login.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    const next = await startBrowserLogin();
    expect(next.state).not.toBe(login.state);
    expect(next.codeVerifier).not.toBe(login.codeVerifier);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exchanges only the returned code with the retained PKCE proof and fixed loopback URI", async () => {
    const login = await startBrowserLogin();
    const fetcher = mockFetch(json(tokenResponse()));
    expect(await completeBrowserLogin(login, browserCallback(login))).toMatchObject({ accountId: "test-account", refreshToken: "refresh-secret" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(tokenUrl);
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: "authorization_code", client_id: clientId, redirect_uri: "http://localhost:1455/auth/callback",
      code: "test-code", code_verifier: login.codeVerifier,
    });
  });

  it.each([
    "https://localhost:1455/auth/callback", "http://127.0.0.1:1455/auth/callback", "http://localhost:1457/auth/callback",
    "http://localhost:1455/other", "http://attacker.example/auth/callback", "http://localhost:1455.attacker.example/auth/callback",
    "http://user@localhost:1455/auth/callback", "http://@localhost:1455/auth/callback", "file:///auth/callback",
  ])("never fetches an unexpected callback destination %s", async destination => {
    const login = await startBrowserLogin();
    const fetcher = mockFetch();
    const callback = `${destination}?code=private-code&state=${login.state}`;
    await expect(completeBrowserLogin(login, callback)).rejects.toMatchObject({ status: 400, code: "codex_callback_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "&code=another-code", "&state=another-state", "&error=denied", "&error_description=private-details", "#", "#fragment", "\n",
  ])("rejects ambiguous, fragmented or malformed callback input %#", async suffix => {
    const login = await startBrowserLogin();
    const fetcher = mockFetch();
    await expect(completeBrowserLogin(login, browserCallback(login) + suffix)).rejects.toMatchObject({ code: "codex_callback_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a mismatched state before processing provider errors", async () => {
    const login = await startBrowserLogin();
    const fetcher = mockFetch();
    for (const query of ["code=private-code&state=wrong", "error=access_denied&state=wrong", `code=private-code`, `state=${login.state}`, `code=&state=${login.state}`]) {
      await expect(completeBrowserLogin(login, `http://localhost:1455/auth/callback?${query}`)).rejects.toMatchObject({ code: "codex_callback_invalid" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("recognizes an authenticated provider denial without disclosing its error detail", async () => {
    const login = await startBrowserLogin();
    const fetcher = mockFetch();
    const callback = `http://localhost:1455/auth/callback?${new URLSearchParams({ state: login.state, error: "access_denied", error_description: "private-error-description" })}`;
    await expect(completeBrowserLogin(login, callback)).rejects.toMatchObject({ code: "codex_login_failed" });
    await expect(completeBrowserLogin(login, callback)).rejects.not.toThrow("private-error-description");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects duplicate provider error parameters without consuming the pending login", async () => {
    const login = await startBrowserLogin();
    const fetcher = mockFetch();
    for (const suffix of ["&error=denied", "&error_description=one&error_description=two"]) {
      await expect(completeBrowserLogin(login, `http://localhost:1455/auth/callback?state=${login.state}&error=denied${suffix}`)).rejects.toMatchObject({ code: "codex_callback_invalid" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects expired logins before token exchange", async () => {
    const login = await startBrowserLogin();
    const fetcher = mockFetch();
    await expect(completeBrowserLogin({ ...login, expiresAt: Date.now() - 1 }, browserCallback(login))).rejects.toMatchObject({ status: 410, code: "codex_login_expired" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403])("makes rejected authorization-code exchange HTTP %s permanent", async status => {
    const login = await startBrowserLogin();
    const fetcher = mockFetch(json({ error: "private-code-invalid", error_description: login.codeVerifier }, status));
    await expect(completeBrowserLogin(login, browserCallback(login))).rejects.toMatchObject({ code: "codex_login_failed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 503])("classifies token exchange HTTP %s as temporary without retrying", async status => {
    const login = await startBrowserLogin();
    const fetcher = mockFetch(json({ error: "private-upstream-detail" }, status));
    await expect(completeBrowserLogin(login, browserCallback(login))).rejects.toMatchObject({ code: "codex_auth_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("invalidates an exchanged code when returned tokens cannot be used", async () => {
    const login = await startBrowserLogin();
    mockFetch(json({ access_token: "missing-token-fields" }));
    await expect(completeBrowserLogin(login, browserCallback(login))).rejects.toMatchObject({ code: "codex_login_failed" });
  });

  it("bounds token exchange to twenty seconds and cancels its body", async () => {
    const login = await startBrowserLogin();
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = mockFetch(new Response(new ReadableStream({ cancel })));
    const attempt = completeBrowserLogin(login, browserCallback(login));
    const assertion = expect(attempt).rejects.toMatchObject({ code: "codex_auth_unavailable" });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Worker Codex device authentication", () => {
  it("starts the official device flow with a fixed client and a 15-minute expiry", async () => {
    const fetcher = mockFetch(json({ device_auth_id: "device-private", usercode: "ABCDE-FGHI", interval: "3" }));
    const started = Date.now();
    const result = await startDeviceLogin();
    expect(result).toMatchObject({ deviceAuthId: "device-private", userCode: "ABCDE-FGHI", intervalSeconds: 5 });
    expect(result.expiresAt).toBeGreaterThanOrEqual(started + 900_000);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toEqual({ client_id: clientId });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it.each([403, 404])("treats HTTP %s as pending without exchanging a token", async status => {
    const fetcher = mockFetch(json({ error: "authorization_pending" }, status));
    expect(await pollDeviceLogin(login())).toEqual({ status: "pending" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ device_auth_id: "device-id", user_code: "ABCD-EFGHI" });
  });

  it("exchanges the device code and PKCE verifier using a fixed callback", async () => {
    const expiration = Math.floor(Date.now() / 1_000) + 3_600;
    const payload = tokenResponse({ access_token: access({ exp: expiration }) });
    const fetcher = mockFetch(json({ authorization_code: "auth-code", code_verifier: "proof-key", code_challenge: "unused-challenge" }), json(payload));
    const result = await pollDeviceLogin(login());
    expect(result).toEqual({ status: "complete", tokens: { accessToken: payload.access_token, refreshToken: "refresh-secret", accountId: "test-account", idToken: payload.id_token, expiresAt: expiration * 1_000 } });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe(tokenUrl);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: "authorization_code", client_id: clientId,
      redirect_uri: "https://auth.openai.com/deviceauth/callback", code: "auth-code", code_verifier: "proof-key",
    });
    expect(init?.redirect).toBe("manual");
  });

  it("rejects expired or extended device sessions before sending secrets", async () => {
    const fetcher = mockFetch();
    for (const expiresAt of [Date.now() - 1, Date.now() + 901_000, NaN]) {
      await expect(pollDeviceLogin({ ...login(), expiresAt })).rejects.toMatchObject({ status: 410, code: "codex_login_expired" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed device parameters and authorization responses", async () => {
    mockFetch(json({ device_auth_id: "secret", user_code: "BAD\r\nCODE", interval: "5" }));
    await expect(startDeviceLogin()).rejects.toMatchObject({ code: "codex_auth_unavailable" });
    const fetcher = mockFetch(json({ authorization_code: "code" }));
    await expect(pollDeviceLogin(login())).rejects.toMatchObject({ code: "codex_auth_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not treat a Cloudflare challenge as a pending login", async () => {
    mockFetch(new Response("private challenge payload", { status: 403, headers: { "cf-mitigated": "challenge" } }));
    await expect(pollDeviceLogin(login())).rejects.toMatchObject({ code: "codex_auth_unavailable" });
  });

  it("limits polling plus token exchange to 25 seconds and cancels an incomplete exchange body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(resolve => {
        setTimeout(() => resolve(json({ authorization_code: "auth-code", code_verifier: "proof-key" })), 14_000);
      }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    vi.stubGlobal("fetch", fetcher);
    const attempt = pollDeviceLogin(login());
    const assertion = expect(attempt).rejects.toMatchObject({ code: "codex_auth_unavailable" });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[1]![1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Worker Codex token refresh", () => {
  it("rotates tokens with the official JSON refresh grant", async () => {
    const value = tokenResponse({ refresh_token: "rotated-refresh", expires_in: 60 });
    const fetcher = mockFetch(json(value));
    const start = Date.now();
    const tokens = await refreshCodexTokens(previous());
    expect(tokens.refreshToken).toBe("rotated-refresh");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(start + 60_000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(tokenUrl);
    expect(JSON.parse(String(init?.body))).toEqual({ grant_type: "refresh_token", client_id: clientId, refresh_token: "previous-refresh" });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("retains refresh and ID tokens when the server omits replacements", async () => {
    mockFetch(json({ access_token: access() }));
    const stored = previous();
    expect(await refreshCodexTokens(stored)).toMatchObject({ refreshToken: stored.refreshToken, idToken: stored.idToken, accountId: stored.accountId });
  });

  it("rejects a changed ChatGPT account instead of rerouting the shared backend", async () => {
    mockFetch(json(tokenResponse({ access_token: access(authClaim("different-account")), id_token: jwt(authClaim("different-account")) })));
    await expect(refreshCodexTokens(previous())).rejects.toMatchObject({ code: "codex_reauthentication_required" });
  });

  it.each([
    [401, { error: "unknown", error_description: "private-auth-secret" }],
    [400, { error: "invalid_grant" }],
    [400, { error: { code: "refresh_token_expired" } }],
    [400, { error: { code: "refresh_token_reused" } }],
    [400, { error: { code: "refresh_token_invalidated" } }],
  ])("classifies permanent refresh rejection %s without leaking upstream errors", async (status, data) => {
    mockFetch(json(data, Number(status)));
    await expect(refreshCodexTokens(previous())).rejects.toMatchObject({ status: 503, code: "codex_reauthentication_required" });
  });

  it.each([403, 429, 500, 503])("preserves stored credentials after transient HTTP %s", async status => {
    mockFetch(json({ error: "temporary-private-details" }, status));
    await expect(refreshCodexTokens(previous())).rejects.toMatchObject({ code: "codex_auth_unavailable" });
  });

  it.each([
    { access_token: "opaque-without-expiration" },
    { access_token: access({ exp: "malformed" }) },
    { access_token: access({ exp: 1 }) },
    { access_token: "sk-api-key", expires_in: 3_600 },
    { access_token: "opaque", expires_in: -1 },
    { access_token: "opaque", expires_in: Infinity },
    { access_token: "secret\nheader", expires_in: 3_600 },
    { access_token: "bad.jwt.encoding", expires_in: 3_600 },
  ])("rejects unusable token fields %#", async extra => {
    mockFetch(json(tokenResponse(extra)));
    await expect(refreshCodexTokens(previous())).rejects.toMatchObject({ code: "codex_auth_unavailable" });
  });

  it("accepts opaque access tokens only when HTTPS token response includes an expiry", async () => {
    mockFetch(json(tokenResponse({ access_token: "opaque-secret", expires_in: 3_600 })));
    expect(await refreshCodexTokens(previous())).toMatchObject({ accessToken: "opaque-secret", accountId: "test-account" });
  });

  it("never follows redirects with a refresh token", async () => {
    const fetcher = mockFetch(new Response("private redirect body", { status: 307, headers: { location: "https://elsewhere.invalid" } }));
    await expect(refreshCodexTokens(previous())).rejects.toMatchObject({ code: "codex_auth_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe("manual");
  });

  it("bounds the response size and sanitizes network failures", async () => {
    mockFetch(new Response("x".repeat(131_073)));
    await expect(refreshCodexTokens(previous())).rejects.toMatchObject({ code: "codex_auth_unavailable" });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private-refresh-secret"));
    vi.stubGlobal("fetch", fetcher);
    await expect(refreshCodexTokens(previous())).rejects.not.toThrow("private-refresh-secret");
  });

  it("times out and cancels a stalled response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    mockFetch(new Response(new ReadableStream({ cancel })));
    const attempt = refreshCodexTokens(previous());
    const assertion = expect(attempt).rejects.toMatchObject({ code: "codex_auth_unavailable" });
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
