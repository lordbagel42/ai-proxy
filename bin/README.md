# Friends AI Proxy CLI

The standalone client for [Friends AI Proxy](https://github.com/lordbagel42/ai-proxy). It provides the same commands as `npm run client` in the repository, with no runtime npm dependencies.

## Install from GitHub Packages

Install Node.js 22 or newer, then install the client:

```sh
npm install @lordbagel42/ai-proxy@0.1.0
```

## Use

```sh
npx ai-proxy login --url https://proxy.example.com
npx ai-proxy models
npx ai-proxy codex
npx ai-proxy codex --model MODEL_ID exec 'Explain this project'
npx ai-proxy logout
```

Check the terminal code in your browser, sign in with Hack Club, and approve the login. The `codex` command requires the native Codex executable to be installed separately. Arguments pass through to Codex; model metadata and your gateway key are supplied for that process without changing your Codex configuration.

Use `npx ai-proxy help` for all commands. `login --no-browser` prints the login link without opening a browser. `npx ai-proxy token` prints your proxy key for explicit client configuration; treat its output as a secret.

Credentials are stored in `~/.config/ai-proxy/credentials.json`, or under `XDG_CONFIG_HOME`, with mode `0600`. Logging out revokes the key at the gateway and removes the local credential. An invitation or existing membership is required to use the gateway.
