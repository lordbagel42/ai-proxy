# Proxmox / Nomad server deployment

The production image runs the same application handlers, Better Auth/Hack Club login, dashboard, provider integrations, and API protocols as the Worker. `server/main.ts` supplies Node HTTP, static assets, a persistent D1-compatible SQLite binding, background work, and daily cleanup. No Cloudflare runtime or API is required by the server.

Domains, identities, and host paths below are examples. Supply your own values; when migrating an existing deployment, preserve its owner identity and original encryption secrets.

## Image and process

```sh
npm ci
npm run check
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" \
  -t "ai-proxy:proxmox-$(git rev-parse --short=12 HEAD)" .
npm run test:server:docker -- --image "ai-proxy:proxmox-$(git rev-parse --short=12 HEAD)"
```

The multistage image pins Node **22.23.2** by digest. It contains bundled application code, public assets, and migrations, with no application credentials or local state. It runs as UID/GID **1000:1000**, executes `node /app/dist-server/main.mjs`, and listens on **0.0.0.0:3000**. SQLite uses Node's built-in driver; no native addon build or npm install is needed at runtime. The runtime image is based on Debian bookworm-slim.

Deploy exactly **one process/one Nomad allocation**, with no overlapping rolling replacements or canaries. Database locks do not coordinate refreshes across different copies of the database. Pin a unique revision tag or registry digest. For an isolated deployment, `docker save`/`docker load` transfers the same image without requiring a public registry; verify its image ID after transfer.

Use a read-only container filesystem, `cap_drop = ["ALL"]`, no-new-privileges, and a writable `/data` mount. The intended host directory is `/opt/nomad/volumes/ai_proxy_data`, owned by UID 1000, mode 0700. Keep port 3000 private to Traefik/health checks. Public traffic follows Cloudflare Tunnel → Traefik → the service. Disable response buffering and allow at least **360 seconds** for requests/idle reads so SSE and long generations work.

## Configuration and secrets

Mount a restricted dotenv file read-only at **`/run/secrets/ai-proxy.env`**. The file is required, must be readable by UID 1000, and cannot be accessible to other users (0400/0600, or 0440 with a restricted matching group). It is parsed as data, never sourced as shell code. Explicit process environment variables override values in the file. `AI_PROXY_ENV_FILE` can select another path.

Required existing secret names:

- `BETTER_AUTH_SECRET`: preserve the exact value for existing sessions and encrypted Hack Club tokens.
- `HACKCLUB_CLIENT_ID`, `HACKCLUB_CLIENT_SECRET`: the existing Hack Club OAuth registration.
- `CODEX_TOKEN_KEY`: preserve the exact **43-character, unpadded base64url key** for the encrypted ChatGPT connection. The owner ID is also authenticated encryption context; preserve it.
- For other configured providers, each name referenced by its `credential` field.

Required/non-secret production values:

```dotenv
BETTER_AUTH_URL=https://proxy.example.com
OWNER_HACKCLUB_ID=ident!your-owner-id
ALLOWED_HACKCLUB_IDS=ident!your-owner-id
REQUESTS_PER_MINUTE=20
PROVIDERS_JSON='[{"id":"codex","protocol":"codex","discoverModels":true,"models":{}}]'
DATABASE_PATH=/data/ai-proxy.sqlite
AI_PROXY_SERVING_ENABLED=false
```

Optional values: `HOST` (default `0.0.0.0`), `PORT` (3000), `SHUTDOWN_GRACE_MS` (30000), `ASSETS_PATH` (`/app/public` in Docker), `MIGRATIONS_PATH` (`/app/migrations`), `TRUSTED_PROXY_IPS` (empty by default). Set `TRUSTED_PROXY_IPS` to the verified immediate Traefik peer IP or a tightly scoped CIDR. Account for container networking/SNAT. The trusted ingress must overwrite `CF-Connecting-IP` and be inaccessible to untrusted clients. Other forwarding headers are removed; request origins always come from `BETTER_AUTH_URL`.

Hack Club callback stays **`https://proxy.example.com/api/auth/callback/hackclub`**. ChatGPT browser login retains **`http://localhost:1455/auth/callback`**, which is pasted into the dashboard.

The existing Worker secrets are not readable using Wrangler's secret-list API. Recover the original deployment secret source or coordinate secure recovery with the deployment owner before importing encrypted data. Do not generate replacement keys. Never put values in Git, image layers, Nomad job documents, command arguments, or handoff messages.

## Import and migration tools

Builds produce `/app/dist-server/db-cli.mjs` in the image. All maintenance runs **offline**, with the application process stopped. Commands are `init`, `import`, `migrate`, and `check`, each accepting `--database` and optional `--migrations`. `import` additionally requires `--sql`.

Given an image reference in `AI_PROXY_IMAGE` and restricted export directory `/secure/ai-proxy-export` containing `d1.sql`:

```sh
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --mount type=bind,src=/opt/nomad/volumes/ai_proxy_data,dst=/data \
  --mount type=bind,src=/secure/ai-proxy-export,dst=/run/migration,readonly \
  "$AI_PROXY_IMAGE" node dist-server/db-cli.mjs import \
  --database /data/ai-proxy.sqlite --sql /run/migration/d1.sql

docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --mount type=bind,src=/opt/nomad/volumes/ai_proxy_data,dst=/data \
  "$AI_PROXY_IMAGE" node dist-server/db-cli.mjs check \
  --database /data/ai-proxy.sqlite
```

The importer refuses an existing database or WAL/SHM journal, loads into a private temporary database, checks integrity/foreign keys/schema/migrations, and publishes the new database without overwrite. It preserves ciphertext and all application tables. Cloudflare `_cf_*` internal objects are removed. An omitted D1 migration ledger is adopted only after verifying the complete application schema. Normal server startup validates the existing database and refuses missing or outdated schema; it does not create a fresh database or run migrations implicitly. `init` is only for a new empty installation, never a migration of this deployment.

For later upgrades, stop the application, make a consistent backup, run `db-cli migrate`, then start the new image. SQLite uses WAL, foreign keys, and FULL synchronous mode. Copying only the main `.sqlite` file while it is running is not a backup: stop/checkpoint first, or use SQLite's online backup facilities.

The reusable-invitation update includes `0005_invite-use-limits.sql`. Apply it before running the updated server. Existing invites retain their single-use limit, and already accepted invitations remain spent.

## Candidate, freeze, and cutover

1. Recover the exact existing secrets into restricted storage. Export D1 into a restricted directory and retain a rollback copy. Coordinate the database transfer and routing with the deployment operator.
2. Import into candidate storage and compare table counts and encrypted connection presence. Start with `AI_PROXY_SERVING_ENABLED=false`. `/health` returns `{"status":"ok","serving":false}` only after schema validation; every other route returns 503, no provider requests are made, and cleanup is disabled. A successful health check alone does **not** prove inference works.
3. Deploy this revision's Worker code with `MAINTENANCE_MODE=true` as an environment binding at **100%** when ready to freeze. The switch blocks every non-health route and scheduled cleanup, including on workers.dev. Earlier Worker revisions do not have this switch. Confirm `/health` reports `serving:false` and authenticated API calls return 503 on both public entrypoints.
4. Wait at least **six minutes** for old generations, OAuth exchanges, token refreshes, and background writes to drain before the final export. Do not disable maintenance during final export or candidate validation.
5. Stop the candidate, retain its old DB separately, import the final D1 export into an absent destination, validate it, and compare final counts. Keep the Worker frozen while enabling `AI_PROXY_SERVING_ENABLED=true` and starting exactly one active allocation.
6. Verify real authenticated account model discovery and generation **from the Proxmox deployment**. Check dashboard/browser catalog parity, native Codex model picker and a shell-tool round trip, all six API/stream variants, HCA sessions, invitations, metrics, and disconnect accounting. The repository's controlled-upstream tests do not establish account eligibility or eliminate the observed ChatGPT 403.
7. Cut over `proxy.example.com` through the tunnel after validation. Preserve the original Worker and D1 backup, with the Worker still frozen. New Node tokens/session data must not be discarded on rollback: stop Node first and coordinate a current consistent database transfer back before reactivating the Worker. Never activate both copies of refresh credentials.

## Cleanup, shutdown, and logging

While serving, one in-process timer invokes the existing cleanup at **03:17 UTC daily**, deleting expired CLI logins, legacy quota rows, rate limits, and Codex concurrency leases. Runs cannot overlap. Restarting schedules the next occurrence rather than writing immediately; standby never schedules cleanup.

SIGTERM/SIGINT stop cleanup scheduling and new connections, finish active requests and all registered `waitUntil` work, checkpoint SQLite, and exit. The default deadline is **30 seconds**; after it, requests are aborted and sockets closed, with at most **one extra second** for cancellation/accounting cleanup before exit code 1. Configure Nomad `kill_timeout` to at least **40 seconds**. Set a longer `SHUTDOWN_GRACE_MS` and kill timeout if uninterrupted five-minute requests are required during replacement.

Logs contain lifecycle events and safe categorical failure metadata. They do not contain secret values, request bodies, upstream response bodies, or cookie headers. Existing application analytics remain available in SQLite. Cloudflare's automatic Worker traces do not run inside this Node container; add infrastructure tracing separately if needed.
