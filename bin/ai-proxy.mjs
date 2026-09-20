#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, writeFile, chmod, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { codexConfig, fetchModelCatalog, selectModel } from "./codex-models.mjs";

const args = process.argv.slice(2);
const command = args.shift();
const credentialsPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ai-proxy", "credentials.json");
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  args.splice(i, 2); return value;
}
function serverUrl(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use the proxy origin, for example https://proxy.example.com.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("HTTPS is required except on localhost.");
  return url.origin;
}
async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
  return data;
}
async function credentials() {
  let saved;
  try { saved = JSON.parse(await readFile(credentialsPath, "utf8")); }
  catch { throw new Error("Sign in first: ai-proxy login --url https://your-proxy.example"); }
  if (typeof saved.key !== "string" || !/^ap_[a-f0-9]{64}$/.test(saved.key)) throw new Error("Invalid saved credential. Sign in again.");
  saved.url = serverUrl(saved.url);
  return saved;
}
function openBrowser(url) {
  const program = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const child = spawn(program, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { stdio: "ignore", detached: true });
  child.on("error", () => {}); child.unref();
}

try {
  if (command === "login") {
    const url = serverUrl(option("--url", "http://localhost:8787"));
    const pending = await post(url, "/api/cli/start", {});
    const verification = new URL(pending.verification_uri_complete);
    if (verification.origin !== url) throw new Error("The server returned a login URL on a different origin.");
    console.error(`Open ${verification.href}\nConfirm the terminal code: ${pending.user_code}`);
    if (!args.includes("--no-browser")) openBrowser(verification.href);
    const deadline = Date.now() + Math.min(pending.expires_in, 600) * 1000;
    let result;
    while (Date.now() < deadline) {
      await delay(Math.max(pending.interval, 2) * 1000);
      result = await post(url, "/api/cli/poll", { device_code: pending.device_code });
      if (result.status === "approved") break;
    }
    if (result?.status !== "approved") throw new Error("Login timed out. Run the login command again.");
    if (!/^ap_[a-f0-9]{64}$/.test(result.key)) throw new Error("The server returned an invalid API key.");
    await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 });
    const temp = `${credentialsPath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ url, key: result.key, keyId: result.key_id }) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, credentialsPath); await chmod(credentialsPath, 0o600);
    console.error("Signed in. Run: ai-proxy codex");
  } else if (command === "codex") {
    const saved = await credentials();
    const catalog = await fetchModelCatalog(saved);
    const model = selectModel(catalog, option("--model", option("-m")));
    const temporary = await mkdtemp(join(tmpdir(), "ai-proxy-models-"));
    try {
      const catalogPath = catalog.models.length ? join(temporary, "models.json") : undefined;
      if (catalogPath) await writeFile(catalogPath, JSON.stringify({ models: catalog.models }), { mode: 0o600 });
      const overrides = Object.entries(codexConfig(saved.url, model, catalogPath)).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
      // Per-process overrides preserve the user's global Codex config and authentication.
      const child = spawn("codex", [...args.filter((a) => a !== "--"), ...overrides], { stdio: "inherit", env: { ...process.env, AI_PROXY_API_KEY: saved.key } });
      const terminate = () => child.kill("SIGTERM");
      process.once("SIGTERM", terminate);
      try {
        process.exitCode = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => resolve(code ?? 1));
        });
      } finally { process.removeListener("SIGTERM", terminate); }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  } else if (command === "models") {
    const catalog = await fetchModelCatalog(await credentials());
    const selected = selectModel(catalog);
    for (const model of catalog.data) console.log(`${model.id}${model.id === selected ? " (default)" : ""}`);
  } else if (command === "token") {
    // Intended for Codex command-backed auth or explicit shell substitution.
    process.stdout.write((await credentials()).key + "\n");
  } else if (command === "logout") {
    const saved = await credentials();
    const response = await fetch(`${saved.url}/api/cli/logout`, { method: "POST", headers: { authorization: `Bearer ${saved.key}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok && response.status !== 401) throw new Error(`Could not revoke the key (HTTP ${response.status}). The local credential was kept; retry or revoke it in the portal.`);
    await rm(credentialsPath);
    console.error("Signed out. The proxy key was revoked and removed from this machine.");
  } else {
    console.log("Usage:\n  ai-proxy login --url https://your-proxy.example [--no-browser]\n  ai-proxy models\n  ai-proxy codex [--model MODEL] [Codex arguments]\n  ai-proxy token\n  ai-proxy logout\n\nFrom a source checkout, replace ai-proxy with npm run client --.");
    if (command && !["help", "--help", "-h"].includes(command)) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed.");
  process.exitCode = 1;
}
