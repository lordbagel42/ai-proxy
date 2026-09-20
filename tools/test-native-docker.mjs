#!/usr/bin/env node
// Offline regression: the unchanged live Docker runner -> production Node gateway
// -> strict local synthetic Codex fixtures. No host credentials or real provider calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'ai-proxy-native-docker-'));
const key = `ap_${randomBytes(32).toString('hex')}`;
const accessToken = 'synthetic-native-unused-outside-fixture';
const accountId = 'synthetic-native-account';
const tokenKey = randomBytes(32);
const model = {
  slug: 'fixture-native', display_name: 'Synthetic Native Model', description: 'Offline fixture',
  default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Low reasoning' }],
  shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0,
  support_verbosity: true, default_verbosity: 'low', apply_patch_tool_type: 'freeform',
  truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 272000,
  experimental_supported_tools: [], input_modalities: ['text'], use_responses_lite: true, supports_experimental_context: true,
  model_messages: { instructions_template: 'Use the supplied tools to carry out the task.' },
};
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const servers = [];
let application;
let applicationLog = '';
let providerError;
let nativeTurns = 0;
const requestShapes = [];
const completedTools = [];
const toolCalls = [];
let providerCalls = 0;
const containerName = `ai-proxy-native-offline-${process.pid}`;
const isolatedEnv = { PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: '1' };

async function run(command, args, { env = isolatedEnv, timeout = 120000 } = {}) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2 ** 22) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2 ** 22) child.kill('SIGKILL'); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  return { code, stdout, stderr };
}
async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
function fixture(body) {
  const native = body.tools?.length > 0;
  let tool;
  let argumentsText;
  let reply = 'relay-integration-ok';
  if (native) {
    nativeTurns++;
    assert.equal(body.reasoning.effort, 'low');
    const results = body.input.filter(item => item.type === 'function_call_output');
    for (const item of results) if (!completedTools.some(result => result.call_id === item.call_id)) completedTools.push(item);
    if (nativeTurns <= 2) {
      tool = body.tools.find(item => item.name === 'exec_command' || item.name.endsWith('__exec_command'));
      assert.ok(tool, 'native runner must advertise exec_command');
      argumentsText = JSON.stringify({ cmd: nativeTurns === 1 ? 'printf relay-tool-ok > proof.txt' : 'cat proof.txt', max_output_tokens: 100 });
      toolCalls.push(JSON.parse(argumentsText));
    } else {
      assert.equal(nativeTurns, 3, 'native runner must need exactly two tool actions');
      assert.equal(results.length, 2, 'native history must preserve both tool outputs');
      assert.match(results[1].output, /relay-tool-ok/);
      reply = 'relay-native-ok';
    }
  }
  const id = `resp_fixture_${providerCalls}`;
  const itemId = `item_fixture_${providerCalls}`;
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: model.slug, output: [] };
  const item = tool
    ? { id: itemId, type: 'function_call', status: 'in_progress', call_id: `call_fixture_${nativeTurns}`, name: tool.name, arguments: '' }
    : { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', phase: 'final_answer', content: [] };
  const events = [{ type: 'response.created', response }, { type: 'response.output_item.added', output_index: 0, item }];
  const complete = tool ? { ...item, status: 'completed', arguments: argumentsText }
    : { ...item, status: 'completed', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  if (tool) {
    const split = Math.floor(argumentsText.length / 2);
    for (const delta of [argumentsText.slice(0, split), argumentsText.slice(split)]) events.push({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: itemId, delta });
    events.push({ type: 'response.function_call_arguments.done', output_index: 0, item_id: itemId, arguments: argumentsText });
  } else {
    const coords = { output_index: 0, item_id: itemId, content_index: 0 };
    events.push({ type: 'response.content_part.added', ...coords, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', ...coords, delta: reply },
      { type: 'response.output_text.done', ...coords, text: reply },
      { type: 'response.content_part.done', ...coords, part: complete.content[0] });
  }
  events.push({ type: 'response.output_item.done', output_index: 0, item: complete },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [], usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } } });
  return events.map((event, sequence_number) => frame({ ...event, sequence_number })).join('');
}

try {
  await build({ entryPoints: ['server/main.ts', 'server/db-cli.ts'], outdir: directory, outExtension: { '.js': '.mjs' },
    platform: 'node', target: 'node22.23', format: 'esm', bundle: true, logLevel: 'silent',
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
  const provider = await listen(createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${accessToken}`);
      assert.equal(request.headers['chatgpt-account-id'], accountId);
      if (request.url === '/models?client_version=0.154.0') {
        assert.equal(request.method, 'GET');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [model] }));
        return;
      }
      assert.equal(request.url, '/responses');
      assert.equal(request.method, 'POST');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.model, model.slug);
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, undefined);
      providerCalls++;
      const text = fixture(body);
      response.writeHead(200); // Actual subscription endpoint may omit Content-Type.
      response.end(text);
    } catch (error) { providerError = error; response.writeHead(500); response.end(); }
  }));
  const preload = join(directory, 'fixture-preload.mjs');
  await writeFile(preload, `const nativeFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const req=new Request(input,init);const url=new URL(req.url);if(url.origin==='https://chatgpt.com'&&(url.pathname==='/backend-api/codex/responses'||url.pathname==='/backend-api/codex/models'))return nativeFetch(new Request(${JSON.stringify(provider)}+url.pathname.replace('/backend-api/codex','')+url.search,req));throw Error('Offline fixture rejects unexpected provider or OAuth request');};`, { mode: 0o600 });
  const database = join(directory, 'test.sqlite');
  const initialized = await run(process.execPath, [join(directory, 'db-cli.mjs'), 'init', '--database', database, '--migrations', join(root, 'migrations')]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const db = new DatabaseSync(database);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)').run('native-user', 'Native Fixture', 'native@example.test', now, now);
    db.prepare('INSERT INTO account (id,account_id,provider_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('native-account', 'ident!native', 'hackclub', 'native-user', now, now);
    db.prepare('INSERT INTO api_key (id,user_id,name,key_prefix,key_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run('native-key', 'native-user', 'Offline', key.slice(0, 11), createHash('sha256').update(key).digest('hex'), now, now + 3600000);
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', tokenKey, nonce);
    cipher.setAAD(Buffer.from('friends-ai-proxy:codex:v1:ident!native:tokens'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ accessToken, refreshToken: 'synthetic-never-refreshed', accountId, expiresAt: now + 3600000 })), cipher.final(), cipher.getAuthTag()]);
    db.prepare('INSERT INTO codex_connection (id,owner_identity,credentials,expires_at,updated_at) VALUES (?,?,?,?,?)').run('codex', 'ident!native', `v1.${nonce.toString('base64url')}.${encrypted.toString('base64url')}`, now + 3600000, now);
  } finally { db.close(); }
  const reservation = createServer();
  const appOrigin = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  servers.pop();
  const envFile = join(directory, 'app.env');
  const env = { HOST: '127.0.0.1', PORT: new URL(appOrigin).port, BETTER_AUTH_URL: appOrigin,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), HACKCLUB_CLIENT_ID: 'synthetic', HACKCLUB_CLIENT_SECRET: 'synthetic', OWNER_HACKCLUB_ID: 'ident!native',
    REQUESTS_PER_MINUTE: '100', CODEX_TOKEN_KEY: tokenKey.toString('base64url'), DATABASE_PATH: database,
    ASSETS_PATH: join(root, 'public'), MIGRATIONS_PATH: join(root, 'migrations'), SHUTDOWN_GRACE_MS: '1000' };
  await writeFile(envFile, Object.entries(env).map(([name, value]) => `${name}='${value}'`).join('\n'), { mode: 0o600 });
  application = spawn(process.execPath, ['--import', preload, join(directory, 'main.mjs')], { cwd: root, env: { ...isolatedEnv, AI_PROXY_ENV_FILE: envFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  application.stdout.on('data', chunk => { applicationLog += chunk; });
  application.stderr.on('data', chunk => { applicationLog += chunk; });
  for (let attempt = 0; ; attempt++) {
    if ((await fetch(`${appOrigin}/health`).catch(() => null))?.ok) break;
    assert.ok(attempt < 100 && application.exitCode === null, applicationLog);
    await delay(50);
  }
  const frontend = await listen(createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (request.url.endsWith('/responses') && bytes.length) {
        const body = JSON.parse(bytes);
        if (Array.isArray(body.input) && body.input.some(item => item.type === 'additional_tools')) {
          assert.equal(body.tools, undefined, 'Responses Lite must send tools inside input');
          assert.equal(body.instructions, undefined, 'Responses Lite sends instructions as developer messages');
          assert.equal(body.reasoning.effort, 'low');
          assert.equal(body.reasoning.context, 'all_turns');
          assert.equal(body.input[0].type, 'additional_tools');
          assert.equal(body.input[0].role, 'developer');
          assert.ok(body.input[0].tools.length > 0);
          requestShapes.push({ reasoning: body.reasoning, input: body.input.map(item => ({ type: item.type, role: item.role,
            content: Array.isArray(item.content) ? 'array' : typeof item.content,
            output: Array.isArray(item.output) ? 'array' : typeof item.output })) });
        }
      }
      const upstream = await fetch(new URL(request.url, appOrigin), { method: request.method, headers: request.headers, body: bytes.length ? bytes : undefined });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(response); else response.end();
    } catch (error) { providerError ??= error; response.writeHead(500); response.end(); }
  }));
  const keyFile = join(directory, 'key');
  await writeFile(keyFile, key, { mode: 0o600 });
  const execution = await run('docker', ['run', '--rm', '--init', '--name', containerName, '--network=host', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=1g', '--cpus=2', '--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '--mount', `type=bind,source=${keyFile},target=/run/secrets/proxy-key,readonly`,
    '--mount', `type=bind,source=${join(root, 'tools/docker-live.mjs')},target=/opt/ai-proxy/tools/docker-live.mjs,readonly`,
    '--mount', `type=bind,source=${join(root, 'bin')},target=/opt/ai-proxy/bin,readonly`,
    'ai-proxy-e2e:codex-0.154.0', '--live', '--url', frontend.replace('127.0.0.1', 'localhost'), '--key-file', '/run/secrets/proxy-key', '--model', model.slug], { timeout: 240000 });
  process.stdout.write(execution.stdout);
  console.log(JSON.stringify({ nativeRequestShapes: requestShapes }));
  if (providerError) throw providerError;
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(providerCalls, 9, 'six protocol requests and three native turns');
  assert.equal(nativeTurns, 3);
  assert.equal(requestShapes.length, 3, 'all native turns must exercise Responses Lite additional_tools');
  assert.equal(completedTools.length, 2);
  assert.deepEqual(toolCalls.map(call => call.cmd), ['printf relay-tool-ok > proof.txt', 'cat proof.txt']);
  console.log('PASS exact Docker live runner offline: full protocol matrix, native picker, two shell actions, complete tool history and final reply.');
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await run('docker', ['rm', '--force', containerName], { timeout: 10000 }).catch(() => {});
  if (application && application.exitCode === null) { application.kill('SIGTERM'); await Promise.race([new Promise(resolve => application.once('close', resolve)), delay(5000)]); if (application.exitCode === null) application.kill('SIGKILL'); }
  for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
