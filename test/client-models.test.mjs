import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { codexConfig, fetchModelCatalog, selectModel } from '../bin/codex-models.mjs';

const catalog = {
  object: 'list', data: [{ id: 'account-fast' }, { id: 'account-reasoning' }],
  models: [{ slug: 'account-fast', context_window: 128000 }, { slug: 'account-reasoning', context_window: 256000 }],
  default_model: 'account-reasoning',
};
test('selects the upstream default instead of a hard-coded alias', () => {
  assert.equal(selectModel(catalog), 'account-reasoning');
  assert.equal(selectModel(catalog, 'account-fast'), 'account-fast');
  assert.equal(selectModel(catalog, 'codex'), 'account-reasoning');
  assert.throws(() => selectModel(catalog, 'missing'), /unavailable/);
});
test('keeps static providers usable without native model metadata', async () => {
  const generic = { object: 'list', data: [{ id: 'claude' }], models: [], default_model: 'claude' };
  assert.deepEqual(await fetchModelCatalog({ url: 'https://relay.example', key: 'test-key' }, async () => Response.json(generic)), generic);
  assert.equal(selectModel(generic), 'claude');
  assert.equal(codexConfig('https://relay.example', 'claude').model_catalog_json, undefined);
  assert.throws(() => selectModel(generic, 'codex'), /unavailable/);
});
test('fetches account metadata with credential forwarding only to the gateway', async () => {
  const saved = { url: 'https://relay.example', key: 'test-key' };
  const result = await fetchModelCatalog(saved, async (url, options) => {
    assert.equal(url, 'https://relay.example/v1/models');
    assert.equal(options.headers.authorization, 'Bearer test-key');
    assert.equal(options.redirect, 'error');
    return Response.json(catalog);
  });
  assert.deepEqual(result, catalog);
});
test('rejects unavailable catalogs instead of displaying invented models', async () => {
  const saved = { url: 'https://relay.example', key: 'test-key' };
  await assert.rejects(fetchModelCatalog(saved, async () => Response.json({ data: [], models: [] })), /no available models/);
  await assert.rejects(fetchModelCatalog(saved, async () => Response.json({ data: [{ id: 'codex' }] })), /metadata/);
  await assert.rejects(fetchModelCatalog(saved, async () => Response.json({ error: { message: 'Reconnect ChatGPT.' } }, { status: 503 })), /Reconnect ChatGPT/);
});
test('passes catalog and endpoint through process configuration without embedding the API key', () => {
  const config = codexConfig('https://relay.example', 'account-fast', '/tmp/catalog/models.json');
  assert.equal(config.model, 'account-fast');
  assert.equal(config.model_catalog_json, '/tmp/catalog/models.json');
  assert.equal(config['model_providers.friends_proxy.base_url'], 'https://relay.example/v1');
  assert.equal(config['model_providers.friends_proxy.env_key'], 'AI_PROXY_API_KEY');
});
test('helper launches native Codex with temporary catalog and preserves user configuration', async () => {
  const working = await mkdtemp(join(tmpdir(), 'ai-proxy-client-test-'));
  const key = `ap_${'a'.repeat(64)}`;
  let authorized = false;
  const server = createServer((request, response) => {
    authorized = request.headers.authorization === `Bearer ${key}`;
    assert.equal(request.url, '/v1/models');
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(catalog));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const configHome = join(working, 'config');
  const codexHome = join(working, 'codex');
  const fakeBin = join(working, 'bin');
  const reportPath = join(working, 'report.json');
  try {
    await mkdir(join(configHome, 'ai-proxy'), { recursive: true });
    await mkdir(codexHome); await mkdir(fakeBin);
    await writeFile(join(configHome, 'ai-proxy', 'credentials.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, key }), { mode: 0o600 });
    await writeFile(join(codexHome, 'config.toml'), 'existing-config');
    await writeFile(join(codexHome, 'auth.json'), 'existing-auth');
    await writeFile(join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const overrides = Object.fromEntries(args.flatMap((value, index) => value === '-c' ? [[args[index + 1].split('=')[0], JSON.parse(args[index + 1].slice(args[index + 1].indexOf('=') + 1))]] : []));
const catalog = JSON.parse(fs.readFileSync(overrides.model_catalog_json, 'utf8'));
fs.writeFileSync(process.env.TEST_REPORT_PATH, JSON.stringify({ overrides, catalog, hasCredential: /^ap_[a-f0-9]{64}$/.test(process.env.AI_PROXY_API_KEY), mode: fs.statSync(overrides.model_catalog_json).mode & 511 }));
`, { mode: 0o700 });
    const child = spawn(process.execPath, [process.env.AI_PROXY_CLIENT_ENTRY || resolve('bin/ai-proxy.mjs'), 'codex', 'exec', '--model', 'account-fast', 'synthetic prompt'], {
      env: { ...process.env, HOME: working, XDG_CONFIG_HOME: configHome, CODEX_HOME: codexHome, PATH: `${fakeBin}:${process.env.PATH}`, TEST_REPORT_PATH: reportPath },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', (chunk) => stderr += chunk);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr);
    assert.equal(authorized, true);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.overrides.model, 'account-fast');
    assert.equal(report.hasCredential, true);
    assert.equal(report.mode, 0o600);
    assert.deepEqual(report.catalog, { models: catalog.models });
    await assert.rejects(access(report.overrides.model_catalog_json), { code: 'ENOENT' });
    assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8'), 'existing-config');
    assert.equal(await readFile(join(codexHome, 'auth.json'), 'utf8'), 'existing-auth');
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(working, { recursive: true, force: true });
  }
});
