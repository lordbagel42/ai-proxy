# Public repository preparation

Reviewed September 20, 2026. Repository visibility is managed by the owner; this preparation does not change it.

## Review scope and results

- Gitleaks 8.30.1 scanned all 11 existing commits across local and fetched remote refs and tags, with no secret findings. Its official release archive was verified against its published SHA-256 checksum.
- Configured local secret values were compared against historical Git blobs without displaying their contents; no matches were found.
- The completed CLI publishing workflow's logs were scanned with no secret findings. There were no uploaded Actions artifacts, repository issues, pull requests, or GitHub releases to review. No wiki repository was found.
- Commit authors use GitHub's `users.noreply.github.com` address.
- `npm audit` reported zero known vulnerabilities at the time of review.
- Type checks, application and client tests, Worker/Node builds, and installation tests for the CLI package are the validation gates. The `Check project` workflow repeats these checks and scans Git history on pushes and pull requests with a read-only token and no production credentials.

Automated scans detect known patterns and advisories; they do not prove the absence of every security issue.

## Changes made

The shared Wrangler configuration and generated types use example domains and no production owner, Cloudflare account ID, or database ID. Existing operator settings were preserved locally in the ignored `wrangler.production.local.jsonc`, which `npm run deploy` now reads. New operators create that private file from the shared template.

Documentation uses example deployment values, distinguishes historical integration results from current availability, and includes contribution and security-reporting guidance. Ignore rules cover private configuration, credentials, databases, package archives, and common backup/export locations.

Earlier commits and the existing client release tag still contain nonsecret deployment metadata, including the former domain, owner identity, account ID, and database ID. Those identifiers do not grant authentication or database access. They have not been removed from Git history. If the owner wants that metadata hidden as a privacy preference, history must be rewritten before changing visibility.

## Visibility and distribution

The repository can be made publicly viewable after the preparation commit passes `Check project`. A public repository does not grant access to any running gateway or upstream account, and changing its visibility does not deploy application changes.

After changing visibility, enable **Private vulnerability reporting** in the repository's security settings so the reporting link in `SECURITY.md` is available. GitHub did not expose that setting while this repository was private.

No project-wide open-source license has been selected. Public viewing and granting an open-source license are separate decisions; existing third-party license notices are retained.

The CLI remains published to GitHub's npm registry. Repository visibility and package visibility are separate settings. The documented `npm install @lordbagel42/ai-proxy@0.1.0` command assumes npm is already configured to resolve that scope through GitHub Packages and the caller has package access. This preparation does not publish the package to npmjs.org or change the existing package's visibility.
