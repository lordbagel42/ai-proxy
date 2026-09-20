# Security policy

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/lordbagel42/ai-proxy/security/advisories/new) for this repository. If the form is unavailable, open an issue asking the maintainer to enable private reporting, without disclosing the vulnerability itself.

Do not include credentials, OAuth callback URLs, live invitation links, personal data, database exports, or an exploitable proof of concept in a public issue. A private report should describe the affected revision, the impact, and reproduction steps using synthetic accounts and data.

Fixes target the current `main` branch. Older deployments should update and apply the documented database migrations; there is no long-term support promise for earlier revisions.

## Deployment boundaries

- A public source repository does not grant access to a hosted gateway or an upstream account. Gateway access still requires an invitation or configured membership.
- Keep `.dev.vars`, environment files, private Wrangler configuration, database backups, and client credentials outside Git. Never bake them into package tarballs or container images.
- Supply a distinct `BETTER_AUTH_SECRET` and `CODEX_TOKEN_KEY` for each deployment. Preserve those values, and the owner identity, when migrating an existing database. Replacing them is not a recovery procedure.
- Set the owner explicitly and use your own Hack Club OAuth registration. The shared configuration has no default owner or preconfigured production account.
- Use HTTPS and only trust forwarding headers from an explicitly configured proxy. Keep the SQLite database private and run a single active server process per database.
- Revoke an exposed gateway key or invitation. If an upstream credential or encryption key is exposed, stop affected access and coordinate credential rotation and database recovery before restarting.

The automated checks cover known secret patterns, dependency advisories, and tested behavior. They are not a guarantee that every vulnerability or provider compatibility issue has been found.
