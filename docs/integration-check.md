# Integration verification — September 19, 2026

Target: https://relay.raygen.dev. Native client: Codex CLI 0.154.0. Docker client image uses pinned Node 22.23.2 and runs with a read-only filesystem, no capabilities, and a temporary home/workspace. Only a short-lived gateway test key is mounted; the container never receives the owner's ChatGPT credentials or the host Codex home.

## Result

**Live subscription inference is blocked upstream.** A completed ChatGPT sign-in is stored in the Worker, but ChatGPT returns HTTP 403 to its requests. The gateway correctly surfaces a 502 with `codex_upstream_forbidden` instead of claiming successful model discovery or inference.

- Before fixes, the gateway advertised only a hardcoded `codex` alias and an empty native model catalog.
- The first Docker run authenticated to the deployed gateway and attempted all six combinations: Responses, Chat Completions, and Anthropic Messages, each streamed and buffered. Every generation attempt failed with upstream HTTP 403.
- After deployment, the account model endpoint also returned HTTP 403. Safe diagnostics recorded `contentType: text/html`, `server: cloudflare`, `challenge: false`, and an unknown application error code. The absence of a challenge header means this was not identified as an interactive browser challenge.
- A direct Docker comparison, without ChatGPT credentials, reached both subscription endpoints and received the expected HTTP 401 JSON authentication errors using the same client identity headers. This supports a Worker-path access block, but does not identify the upstream rule or prove which alternative hosting environment would work.
- The final Docker test stopped at failed account model discovery: **0 passed, 1 failed, 8 skipped**. Dependent generation and native CLI tests were explicitly skipped; no success is inferred from the controlled tests below.

Final deployed Worker version: `74b294ba-ee71-4e8c-81db-53067b143f20`. The temporary integration key was revoked and confirmed to return HTTP 401 afterward.

One diagnostic request at 22:38:44 UTC had Cloudflare ray `a3de24749a21d8d8-SEA` and gateway request ID `07dfd17a-0764-45aa-8abe-96269788b66a`. No response body, OAuth token, account identifier, prompt, or credential was added to logs or this report.

## Implemented fixes

The gateway discovers the actual account catalog from the fixed Codex endpoint and caches it in D1 for five minutes. Cache entries are fenced by owner and connection version; disconnects and refreshes invalidate them. OpenAI-style model IDs and native Codex metadata share one source. The native helper supplies this catalog through a private temporary `model_catalog_json` file, chooses the account's visible default, and preserves existing user config and authentication.

The Responses adapter accepts native metadata events, forwards validated reasoning controls, and preserves assistant message phase through output and conversation replay. Native identity headers and bounded, sanitized error classification are shared by discovery and inference. The dashboard distinguishes stored authentication from upstream availability.

## Controlled verification

- TypeScript checks, 262 Worker/unit tests, and 6 CLI-helper tests pass.
- Native Codex completes shell tool round trips against Anthropic, Responses, and direct-Codex Worker fixtures.
- Docker's native app-server accepts a full native catalog and returns the expected visible model picker entries.
- Browser checks cover populated/default model display, upstream-error state, member portal, and mobile overflow. Browser fixtures use synthetic users and models.

Run these again with:

```sh
npm run check
npm run test:codex
npm run test:docker -- --live --url https://relay.raygen.dev \
  --key-file /absolute/path/to/temporary-gateway-key
```

Do not retry by changing or resetting the stored encryption key. The current evidence is an upstream access rejection, not a broken vault or a missing Hack Club permission. Maintaining Worker-only hosting would require upstream access to be restored or a supported API provider with separately provisioned credentials. A subscription relay outside Workers is an architectural alternative that still requires its own live validation.
