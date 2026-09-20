#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'pack-destination': { type: 'string' } } });
const temporary = await mkdtemp(join(tmpdir(), 'ai-proxy-package-'));
const destination = values['pack-destination'] ? resolve(values['pack-destination']) : temporary;
const prefix = join(temporary, 'installed');

try {
  await mkdir(destination, { recursive: true });
  // npm 10/11 return an array; npm 12 returns an object keyed by package name.
  const [packed] = Object.values(JSON.parse(execFileSync('npm', ['pack', './bin', '--pack-destination', destination, '--json'], { encoding: 'utf8' })));
  assert.deepEqual(packed.files.map(file => file.path).sort(), ['README.md', 'ai-proxy.mjs', 'codex-models.mjs', 'package.json']);
  execFileSync('npm', ['install', '--global', '--prefix', prefix, join(destination, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  const executable = join(prefix, 'bin', 'ai-proxy');
  const help = execFileSync(executable, ['help'], { encoding: 'utf8' });
  assert.match(help, /ai-proxy login/);
  assert.match(help, /ai-proxy codex/);
  execFileSync(process.execPath, ['--test', 'test/client-models.test.mjs'], {
    stdio: 'inherit', env: { ...process.env, AI_PROXY_CLIENT_ENTRY: executable },
  });
  console.log(`Verified installable package ${packed.name}@${packed.version} (${packed.size} bytes).`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
