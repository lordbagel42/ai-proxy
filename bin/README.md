# Friends AI Proxy CLI

The standalone client for [Friends AI Proxy](https://github.com/lordbagel42/ai-proxy). It provides the same commands as `npm run client` in the repository, with no runtime npm dependencies.

## Install from GitHub Packages

Install Node.js 22 or newer. Authenticate with your GitHub username and a personal access token (classic) with `read:packages` and access to this private package:

```sh
npm login --scope=@lordbagel42 --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @lordbagel42/ai-proxy --registry=https://npm.pkg.github.com
```

GitHub registry authentication downloads the package. The separate Hack Club login below grants access to your gateway.

## Use

```sh
ai-proxy login --url https://relay.raygen.dev
ai-proxy models
ai-proxy codex
ai-proxy codex --model MODEL_ID exec 'Explain this project'
ai-proxy logout
```

Check the terminal code in your browser, sign in with Hack Club, and approve the login. The `codex` command requires the native Codex executable to be installed separately. Arguments pass through to Codex; model metadata and your gateway key are supplied for that process without changing your Codex configuration.

Use `ai-proxy help` for all commands. `login --no-browser` prints the login link without opening a browser. `ai-proxy token` prints your proxy key for explicit client configuration; treat its output as a secret.

Credentials are stored in `~/.config/ai-proxy/credentials.json`, or under `XDG_CONFIG_HOME`, with mode `0600`. Logging out revokes the key at the gateway and removes the local credential. An invitation or existing membership is required to use the gateway.
