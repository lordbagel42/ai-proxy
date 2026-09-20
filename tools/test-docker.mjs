#!/usr/bin/env node
// Explicitly opt in: this makes real requests using the connected upstream account.
import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name} value.`);
  args.splice(i, 2);
  return value;
}
function flag(name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1); return true;
}
function run(command, commandArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code}).`)));
  });
}
try {
  const live = flag('--live');
  const skipBuild = flag('--skip-build');
  const url = option('--url');
  const keyFile = option('--key-file');
  const model = option('--model');
  if (!live || !url || !keyFile || args.length) {
    throw new Error('Usage: node tools/test-docker.mjs --live --url https://your-proxy.example --key-file /absolute/path/to/proxy-key [--model MODEL] [--skip-build]');
  }
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('--url must be an HTTPS origin.');
  }
  const absoluteKey = resolve(keyFile);
  await access(absoluteKey);
  const details = await stat(absoluteKey);
  if (!details.isFile() || details.size > 256 || details.size < 67) throw new Error('--key-file must contain a gateway API key.');
  // --mount uses comma-separated fields; reject ambiguous paths instead of shell quoting.
  if (absoluteKey.includes(',') || absoluteKey.includes('\n')) throw new Error('--key-file cannot contain commas or newlines.');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const image = 'ai-proxy-e2e:codex-0.154.0';
  if (!skipBuild) await run('docker', ['build', '--file', 'Dockerfile.e2e', '--tag', image, '.'], root);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const containerArgs = ['run', '--rm', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=1g', '--cpus=2', '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '--mount', `type=bind,source=${absoluteKey},target=/run/secrets/proxy-key,readonly`,
    image, '--live', '--url', origin.origin, '--key-file', '/run/secrets/proxy-key',
    ...(model ? ['--model', model] : [])];
  console.log(`Testing ${origin.origin} in Docker with Codex 0.154.0; only synthetic integration prompts are sent.`);
  await run('docker', containerArgs, root);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Docker integration failed.');
  process.exitCode = 1;
}
