# Contributing

Use Node.js 22.23.2 or newer and install development dependencies with `npm ci`.

```sh
npm run check
npm run test:client:package
```

These checks use synthetic users and controlled upstreams. They do not require production Cloudflare credentials or a connected ChatGPT account. Docker integration checks are described in the [deployment guide](docs/proxmox-deployment.md).

For local development, copy `.dev.vars.example` to `.dev.vars`, supply your own development credentials and owner identity, and follow the [README](README.md#local-development). Production settings belong in the ignored `wrangler.production.local.jsonc` file, created from the shared template.

Keep changes focused and explain their observable behavior and validation in the pull request. Add regression coverage for changes to access control, request handling, persistence, or protocol conversion.

Database changes need a new migration and an updated Drizzle snapshot. Generate these with `npm run db:generate`, and include any data backfill needed to preserve existing deployments. Do not edit an already released migration.

Use synthetic identities, keys, model catalogs, and upstream responses in fixtures. Do not commit real credentials, database exports, private configuration, or captured user conversations. Report security issues through the [security policy](SECURITY.md).

Publishing is separate from validation. The CLI release workflow publishes only to GitHub Packages and requires a version bump in `bin/package.json` for each new release.
