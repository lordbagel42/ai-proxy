#!/usr/bin/env node
// Tests the production container with synthetic identities and local mock providers only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, chmod, chown, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serializeSignedCookie } from 'better-call';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { image: { type: 'string', default: 'ai-proxy:server-test' }, 'skip-build': { type: 'boolean', default: false } } });
const image = values.image;
const uid = process.getuid?.() || 1000;
const gid = process.getgid?.() || 1000;
const containers = new Set();
let directory;
let provider;
let upstreamRequests = 0;
let codexRequests = 0;
let upstreamError;
let stopping = false;

function run(command, args, { timeout = 120_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args[0]} failed (${signal ?? code}): ${stderr.slice(-2000)}`));
    });
    child.stdin.end(input);
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
function anthropicFixture() {
  return [
    { type: 'message_start', message: { id: 'msg_mock', usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Docker fixture response' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ].map(frame);
}
function responsesFixture() {
  const id = 'resp_mock', itemId = 'msg_mock';
  const part = { type: 'output_text', text: 'Docker fixture response', annotations: [] };
  const item = { id: itemId, type: 'message', role: 'assistant', content: [part], status: 'completed' };
  const coordinates = { item_id: itemId, output_index: 0, content_index: 0 };
  return [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', ...coordinates, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', ...coordinates, delta: part.text },
    { type: 'response.output_text.done', ...coordinates, text: part.text },
    { type: 'response.content_part.done', ...coordinates, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item],
      usage: { input_tokens: 11, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } } } },
  ].map((event, sequence_number) => frame({ ...event, sequence_number }));
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function stopContainer(name) {
  await run('docker', ['stop', '--time', '12', name], { timeout: 20_000 });
  const info = JSON.parse(await run('docker', ['inspect', name]))[0];
  assert.equal(info.State.ExitCode, 0, 'production process must exit cleanly after SIGTERM');
  const logs = await run('docker', ['logs', name]);
  assert.match(logs, /"event":"server_stopped","forced":false/, 'shutdown must drain work without forced termination');
  await run('docker', ['rm', name]);
  containers.delete(name);
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  for (const name of containers) await run('docker', ['rm', '--force', name], { timeout: 20_000 }).catch(() => {});
  containers.clear();
  if (provider) {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });

try {
  if (!values['skip-build']) {
    console.log(`Building production image ${image}.`);
    await run('docker', ['build', '--file', 'Dockerfile', '--tag', image, '.'], { timeout: 600_000 });
  }
  const imageUser = await run('docker', ['image', 'inspect', image, '--format', '{{.Config.User}}']);
  assert.ok(imageUser && !['root', '0', '0:0'].includes(imageUser), 'image must declare a non-root user');
  directory = await mkdtemp(join(tmpdir(), 'ai-proxy-server-docker-'));
  await chmod(directory, 0o700);
  const data = join(directory, 'data');
  await mkdir(data, { mode: 0o700 });
  if (process.getuid?.() === 0) await chown(data, uid, gid);
  const key = `ap_${randomBytes(32).toString('hex')}`;
  const authSecret = randomBytes(32).toString('hex');
  const upstreamSecret = randomBytes(32).toString('hex');
  const codexTokenKey = randomBytes(32);
  const codexAccessToken = 'synthetic-docker-codex-access-token';
  const codexAccountId = 'synthetic-docker-codex-account';
  let sealedCodexCredentials;
  provider = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      const codex = request.url === '/codex/responses';
      assert.equal(request.headers.authorization, `Bearer ${codex ? codexAccessToken : upstreamSecret}`);
      assert.equal(request.headers.cookie, undefined);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.stream, true);
      const anthropic = request.url === '/anthropic/messages';
      assert.ok(anthropic || codex || request.url === '/responses/responses');
      assert.equal(body.model, anthropic ? 'upstream-anthropic' : codex ? 'upstream-codex' : 'upstream-responses');
      if (codex) {
        assert.equal(request.headers['chatgpt-account-id'], codexAccountId);
        assert.equal(request.headers.originator, 'codex_cli_rs');
        assert.equal(request.headers.accept, 'text/event-stream');
        assert.equal(body.store, false);
        assert.equal(body.max_output_tokens, undefined);
        codexRequests++;
      }
      upstreamRequests++;
      // Real Codex can return valid SSE with no Content-Type header.
      response.writeHead(200, codex ? {} : { 'content-type': 'text/event-stream' });
      for (const event of anthropic ? anthropicFixture() : responsesFixture()) {
        response.write(event);
        await sleep(3);
      }
      response.end();
    } catch (error) {
      upstreamError = error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  const providerPort = await listen(provider);
  const fixtureOrigin = `http://127.0.0.1:${providerPort}`;
  const preloadFile = join(directory, 'provider-fixture.mjs');
  await writeFile(preloadFile, `// Test-only fetch routing; never included in the production image.
const nativeFetch = globalThis.fetch;
const fixtureOrigin = ${JSON.stringify(fixtureOrigin)};
const localProviders = new Set([fixtureOrigin + '/anthropic/messages', fixtureOrigin + '/responses/responses']);
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  if (request.url === 'https://chatgpt.com/backend-api/codex/responses') {
    return nativeFetch(new Request(fixtureOrigin + '/codex/responses', request));
  }
  if (localProviders.has(request.url)) return nativeFetch(request);
  throw new Error('Docker fixture rejected unexpected provider or OAuth request.');
};
`, { mode: 0o400 });
  if (process.getuid?.() === 0) await chown(preloadFile, uid, gid);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const variables = {
    HOST: '127.0.0.1', PORT: String(port),
    BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: authSecret, HACKCLUB_CLIENT_ID: 'synthetic-client', HACKCLUB_CLIENT_SECRET: 'synthetic-secret',
    OWNER_HACKCLUB_ID: 'ident!docker', ALLOWED_HACKCLUB_IDS: 'ident!docker', REQUESTS_PER_MINUTE: '100', FIXTURE_PROVIDER_KEY: upstreamSecret,
    CODEX_TOKEN_KEY: codexTokenKey.toString('base64url'),
    PROVIDERS_JSON: JSON.stringify([
      { id: 'fixture-anthropic', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${providerPort}/anthropic`, credential: 'FIXTURE_PROVIDER_KEY', models: { 'fixture-anthropic': 'upstream-anthropic' } },
      { id: 'fixture-responses', protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${providerPort}/responses`, credential: 'FIXTURE_PROVIDER_KEY', models: { 'fixture-responses': 'upstream-responses' } },
      { id: 'fixture-codex', protocol: 'codex', models: { 'fixture-codex': 'upstream-codex' } },
    ]),
  };
  const secretFile = join(directory, 'ai-proxy.env');
  await writeFile(secretFile, Object.entries(variables).map(([name, value]) => `${name}='${value}'`).join('\n') + '\n', { mode: 0o600 });
  if (process.getuid?.() === 0) await chown(secretFile, uid, gid);
  const safety = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--user', `${uid}:${gid}`,
    '--mount', `type=bind,source=${data},target=/data`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m,mode=1777'];
  await run('docker', ['run', '--rm', '--network=none', ...safety, image, 'node', 'dist-server/db-cli.mjs', 'init', '--database', '/data/ai-proxy.sqlite']);
  const db = new DatabaseSync(join(data, 'ai-proxy.sqlite'));
  try {
    const now = Date.now();
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    db.prepare('INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)').run('docker-user', 'Docker Friend', 'docker@example.test', now, now);
    db.prepare('INSERT INTO account (id,account_id,provider_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('docker-account', 'ident!docker', 'hackclub', 'docker-user', now, now);
    db.prepare('INSERT INTO session (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)').run('docker-session', now + 3_600_000, 'synthetic-session-token', now, now, 'docker-user');
    db.prepare('INSERT INTO api_key (id,user_id,name,key_prefix,key_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
      .run('docker-key', 'docker-user', 'Docker fixture', key.slice(0, 11), createHash('sha256').update(key).digest('hex'), now, now + 3_600_000);
    const expiresAt = now + 3_600_000;
    const tokens = { accessToken: codexAccessToken, refreshToken: 'synthetic-docker-unused-refresh-token', accountId: codexAccountId, expiresAt };
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', codexTokenKey, nonce);
    cipher.setAAD(Buffer.from('friends-ai-proxy:codex:v1:ident!docker:tokens'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    sealedCodexCredentials = `v1.${nonce.toString('base64url')}.${encrypted.toString('base64url')}`;
    db.prepare('INSERT INTO codex_connection (id,owner_identity,credentials,expires_at,updated_at) VALUES (?,?,?,?,?)')
      .run('codex', 'ident!docker', sealedCodexCredentials, expiresAt, now);
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
  } finally { db.close(); }
  const cookie = (await serializeSignedCookie('better-auth.session_token', 'synthetic-session-token', authSecret)).split(';')[0];
  const keyHeaders = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const fetchApp = (path, init = {}) => fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  async function start(serving) {
    const name = `ai-proxy-server-test-${process.pid}-${randomBytes(4).toString('hex')}`;
    containers.add(name);
    await run('docker', ['run', '--detach', '--name', name, '--network=host', ...safety,
      '--mount', `type=bind,source=${secretFile},target=/run/secrets/ai-proxy.env,readonly`,
      '--mount', `type=bind,source=${preloadFile},target=/fixtures/provider-fixture.mjs,readonly`,
      '--env', 'SHUTDOWN_GRACE_MS=10000', '--env', `AI_PROXY_SERVING_ENABLED=${serving}`, image,
      'node', '--import', '/fixtures/provider-fixture.mjs', 'dist-server/main.mjs']);
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetchApp('/health').catch(() => null);
      if (response?.ok) {
        assert.deepEqual(await response.json(), { status: 'ok', serving });
        await run('docker', ['exec', name, 'node', 'dist-server/healthcheck.mjs']);
        return name;
      }
      await sleep(100);
    }
    throw new Error('Production container did not become healthy.');
  }

  const standby = await start(false);
  for (const path of ['/', '/admin', '/api/auth/ok', '/api/session', '/api/models', '/v1/models', '/v1/responses']) {
    const response = await fetchApp(path, { headers: keyHeaders });
    assert.equal(response.status, 503, `standby must reject ${path}`);
    assert.equal(response.headers.get('retry-after'), '60');
    await response.arrayBuffer();
  }
  assert.equal(upstreamRequests, 0);
  await stopContainer(standby);
  console.log('PASS standby isolates every application route and exits cleanly.');

  const active = await start(true);
  for (const path of ['/', '/admin', '/app.js', '/admin.js', '/style.css', '/fonts/geist-regular.woff2']) {
    const response = await fetchApp(path);
    assert.equal(response.status, 200, `${path} must be served from the production image`);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await fetchApp('/api/auth/ok')).status, 200);
  assert.equal((await fetchApp('/api/session')).status, 401);
  assert.equal((await fetchApp('/v1/models')).status, 401);
  const session = await fetchApp('/api/session', { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).isOwner, true);
  const listing = await fetchApp('/v1/models', { headers: keyHeaders });
  assert.deepEqual((await listing.json()).data.map(model => model.id), ['fixture-anthropic', 'fixture-responses', 'fixture-codex']);
  console.log('PASS production assets, Better Auth session, authorization and model listing.');

  for (const model of ['fixture-anthropic', 'fixture-responses', 'fixture-codex']) {
    if (model === 'fixture-codex') assert.equal(upstreamRequests, 12, 'preserve the original twelve generic provider cases');
    for (const endpoint of ['messages', 'chat/completions', 'responses']) {
      for (const stream of [false, true]) {
        const content = endpoint === 'responses' ? { input: 'Synthetic Docker integration prompt' }
          : { messages: [{ role: 'user', content: 'Synthetic Docker integration prompt' }], max_tokens: 100 };
        const response = await fetchApp(`/v1/${endpoint}`, { method: 'POST', headers: keyHeaders, body: JSON.stringify({ model, stream, ...content }) });
        assert.equal(response.status, 200, `${model} ${endpoint} stream=${stream}`);
        const body = await response.text();
        assert.match(body, /Docker fixture response/);
        if (stream) {
          assert.match(response.headers.get('content-type'), /text\/event-stream/);
          assert.match(body, endpoint === 'responses' ? /response.completed/ : endpoint === 'messages' ? /message_stop/ : /\[DONE\]/);
          assert.doesNotMatch(body, /response.failed|"type":"error"/);
        } else assert.ok(JSON.parse(body).id);
        if (upstreamError) throw upstreamError;
        console.log(`PASS ${model} -> /v1/${endpoint} (stream=${stream}).`);
      }
    }
  }
  assert.equal(upstreamRequests, 18);
  assert.equal(codexRequests, 6, 'all protocols must handle real HTTP SSE without Content-Type');
  await stopContainer(active);
  const restarted = await start(true);
  const report = await fetchApp('/api/analytics?days=7', { headers: { cookie } });
  assert.equal(report.status, 200);
  const metrics = await report.json();
  assert.equal(metrics.totals.requests, 18);
  assert.equal(metrics.totals.successfulRequests, 18);
  assert.equal(metrics.totals.runningRequests, 0);
  assert.equal(metrics.totals.failedRequests, 0);
  assert.equal(metrics.totals.totalTokens, 312);
  assert.equal(metrics.leaderboard[0].name, 'Docker Friend');
  assert.equal(metrics.leaderboard[0].totalTokens, 312);
  assert.equal(metrics.leaderboard[0].isYou, true);
  assert.equal((await fetchApp('/v1/models', { headers: keyHeaders })).status, 200);
  await stopContainer(restarted);
  const saved = new DatabaseSync(join(data, 'ai-proxy.sqlite'), { readOnly: true });
  try {
    assert.equal(saved.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(saved.prepare('SELECT count(*) AS count FROM usage_event').get().count, 18);
    assert.equal(saved.prepare('SELECT count(*) AS count FROM codex_request').get().count, 0);
    const connection = saved.prepare("SELECT credentials,version,lock_id,lock_expires_at FROM codex_connection WHERE id='codex'").get();
    assert.equal(connection.credentials, sealedCodexCredentials, 'generation must not rotate the synthetic account credentials');
    assert.equal(connection.version, 0);
    assert.equal(connection.lock_id, null);
    assert.equal(connection.lock_expires_at, 0);
    assert.equal(saved.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { saved.close(); }
  console.log('PASS SIGTERM drain, restart, persisted keys/sessions/analytics and SQLite integrity.');
  console.log('Production Docker integration passed; all provider traffic used local synthetic fixtures.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Production Docker integration failed.');
  process.exitCode = 1;
} finally {
  await cleanup();
}
