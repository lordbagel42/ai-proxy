// Offline integration test: real Codex -> real Worker runtime -> mock provider.
// No provider accounts, user configuration, or real credentials are used.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const encode = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const codexWorker = process.argv.includes('--codex-worker');
const responses = codexWorker || process.argv.includes('--responses');
if (process.argv.slice(2).some((argument) => !['--responses', '--codex-worker'].includes(argument)) ||
  (codexWorker && process.argv.includes('--responses'))) throw new Error('Usage: node tools/smoke-codex.mjs [--responses | --codex-worker]');
const providerId = responses ? 'codex' : 'claude';
const tokenKey = Buffer.alloc(32, 9);
const codexAccessToken = 'mock-codex-access-token';
const codexAccountId = 'mock-chatgpt-account';

function responseEvents(useTool, tool, input, turn) {
  const response = { id: `resp_mock_${turn}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: 'mock-codex', output: [] };
  const item = useTool
    ? { id: 'fc_smoke', type: 'function_call', status: 'in_progress', call_id: 'call_smoke', name: tool.name, arguments: '' }
    : { id: 'msg_mock', type: 'message', status: 'in_progress', role: 'assistant', content: [] };
  const events = [
    { type: 'response.created', response },
    { type: 'response.in_progress', response },
    { type: 'response.output_item.added', output_index: 0, item },
  ];
  const complete = useTool
    ? { ...item, status: 'completed', arguments: JSON.stringify(input) }
    : { ...item, status: 'completed', content: [{ type: 'output_text', text: 'proxy-smoke-ok', annotations: [] }] };
  if (useTool) {
    // Deliberately split arguments so the test exercises streaming assembly.
    const argumentsText = complete.arguments;
    const split = Math.floor(argumentsText.length / 2);
    for (const delta of [argumentsText.slice(0, split), argumentsText.slice(split)]) events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta });
    events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: argumentsText });
  } else {
    events.push({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const delta of ['proxy-', 'smoke-ok']) events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta });
    events.push({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'proxy-smoke-ok' });
    events.push({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: complete.content[0] });
  }
  events.push({ type: 'response.output_item.done', output_index: 0, item: complete });
  events.push({ type: 'response.completed', response: { ...response, status: 'completed', output: [complete], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

let calls = 0;
let toolReturned = false;
let sawToolResult = false;
const upstream = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
    if (req.headers.authorization !== `Bearer ${codexWorker ? codexAccessToken : 'mock-relay-only'}`) throw new Error('Wrong upstream credential.');
    if (req.url !== (responses ? '/v1/responses' : '/v1/messages')) throw new Error('Wrong upstream endpoint.');
    if (body.stream !== true || body.model !== `mock-${providerId}`) throw new Error('Wrong upstream request configuration.');
    if (responses && body.store !== false) throw new Error('Responses upstream must disable storage.');
    if (codexWorker) {
      if (req.headers['chatgpt-account-id'] !== codexAccountId) throw new Error('Wrong ChatGPT account.');
      if ('max_output_tokens' in body) throw new Error('Codex subscription requests must omit max_output_tokens.');
      if (req.headers.cookie || req.headers['x-api-key']) throw new Error('Client credentials leaked upstream.');
    }
    sawToolResult ||= responses
      ? body.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_smoke' && item.output.includes('proxy-tool-ok'))
      : body.messages.some((m) => m.content.some((p) => p.type === 'tool_result' && p.content.includes('proxy-tool-ok')));
    const tool = body.tools?.find((t) => ['exec_command', 'shell_command', 'shell'].some((name) => t.name === name || t.name.endsWith(`__${name}`)));
    const toolName = tool?.name.split('__').at(-1);
    const useTool = !!tool && !toolReturned;
    const input = toolName === 'exec_command' ? { cmd: 'printf proxy-tool-ok' }
      : toolName === 'shell_command' ? { command: 'printf proxy-tool-ok' }
        : { command: ['sh', '-c', 'printf proxy-tool-ok'] };
    if (!tool && !toolReturned) console.error('Advertised tools:', body.tools?.map((t) => t.name));
    const block = useTool ? { type: 'tool_use', id: 'call_smoke', name: tool.name, input: {} } : { type: 'text', text: '' };
    const delta = useTool ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'proxy-smoke-ok' };
    toolReturned ||= useTool;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = responses ? responseEvents(useTool, tool, input, calls) : [
      { type: 'message_start', message: { id: 'msg_mock', usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: block },
      { type: 'content_block_delta', index: 0, delta },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ];
    for (const data of events) res.write(encode(data));
    res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const address = upstream.address();
const working = await mkdtemp(join(tmpdir(), 'ai-proxy-codex-smoke-'));
let mf;
let frontend;
try {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'dist/worker.js', compatibilityDate: '2026-09-19', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], serviceBindings: { ASSETS: async () => new Response('test') },
    ...(codexWorker ? { outboundService: async (request) => {
      // Every Worker network request is intercepted. An unexpected URL fails
      // closed instead of reaching an actual account or authentication service.
      if (request.url !== 'https://chatgpt.com/backend-api/codex/responses' || request.method !== 'POST') {
        throw new Error('Unexpected outbound request in direct Codex Worker smoke.');
      }
      const headers = new Headers(request.headers); headers.delete('host');
      return fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: 'POST', headers, body: await request.arrayBuffer(), redirect: 'error', signal: request.signal,
      });
    } } : {}),
    bindings: {
      BETTER_AUTH_URL: 'http://localhost:8787', ALLOWED_HACKCLUB_IDS: 'ident!smoke', REQUESTS_PER_MINUTE: '20',
      RELAY_SHARED_SECRET: 'mock-relay-only',
      ...(codexWorker ? { OWNER_HACKCLUB_ID: 'ident!smoke', CODEX_TOKEN_KEY: tokenKey.toString('base64url') } : {}),
      PROVIDERS_JSON: JSON.stringify([codexWorker
        ? { id: providerId, protocol: 'codex', models: { [providerId]: `mock-${providerId}` } }
        : { id: providerId, protocol: responses ? 'openai-responses' : 'anthropic', baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: 'RELAY_SHARED_SECRET', models: { [providerId]: `mock-${providerId}` } }]),
    },
  }));
  const url = await mf.ready;
  frontend = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (process.env.AI_PROXY_SMOKE_DEBUG && req.url.includes('/responses')) {
        const parsed = JSON.parse(body.toString());
        console.error('Codex tool definitions:', JSON.stringify(parsed.tools?.map((t) => ({ type: t.type, name: t.name, tools: t.tools?.map((f) => ({ name: f.name, type: f.type })) }))));
      }
      const response = await fetch(new URL(req.url, url), { method: req.method, headers: req.headers, body: body.length ? body : undefined });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((resolve) => frontend.listen(0, '127.0.0.1', resolve));
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = await readFile(join('migrations', file), 'utf8');
    await db.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
  }
  const now = Date.now(); const key = `ap_${'1'.repeat(64)}`;
  await db.batch([
    db.prepare('INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?,?,?,?,?)').bind('smoke', 'Smoke', 'smoke@example.com', now, now),
    db.prepare('INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?)').bind('smoke-account', 'ident!smoke', 'hackclub', 'smoke', now, now),
    db.prepare('INSERT INTO api_key (id, user_id, name, key_prefix, key_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?)').bind('smoke-key', 'smoke', 'Smoke test', key.slice(0, 11), createHash('sha256').update(key).digest('hex'), now, now + 60000),
  ]);
  if (codexWorker) {
    const expiresAt = now + 3_600_000;
    const tokens = { accessToken: codexAccessToken, refreshToken: 'mock-codex-refresh-token', accountId: codexAccountId, expiresAt };
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', tokenKey, nonce);
    cipher.setAAD(Buffer.from('friends-ai-proxy:codex:v1:ident!smoke:tokens'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const credentials = `v1.${nonce.toString('base64url')}.${encrypted.toString('base64url')}`;
    await db.prepare('INSERT INTO codex_connection (id, owner_identity, credentials, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('codex', 'ident!smoke', credentials, expiresAt, now).run();
  }
  const config = {
    model: providerId, model_provider: 'friends_proxy', web_search: 'disabled',
    'model_providers.friends_proxy.name': 'Friends AI Proxy',
    'model_providers.friends_proxy.base_url': `http://127.0.0.1:${frontend.address().port}/v1`,
    'model_providers.friends_proxy.env_key': 'AI_PROXY_API_KEY',
    'model_providers.friends_proxy.wire_api': 'responses',
    'model_providers.friends_proxy.request_max_retries': 0,
    'model_providers.friends_proxy.stream_max_retries': 0,
  };
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-C', working,
    ...Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`]),
    'Use the shell once to print proxy-tool-ok, then reply with proxy-smoke-ok.'];
  const child = spawn('codex', args, { env: { ...process.env, AI_PROXY_API_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', (b) => output += b); child.stderr.on('data', (b) => errors += b);
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  clearTimeout(timer);
  if (code !== 0 || calls !== 2 || !output.includes('proxy-smoke-ok') || !toolReturned || !sawToolResult) {
    throw new Error(`Codex smoke failed (exit=${code}, requests=${calls}, tool=${toolReturned}, result=${sawToolResult}).\n${output}\n${errors}`);
  }
  if (codexWorker && (await db.prepare('SELECT count(*) AS count FROM codex_request').first()).count !== 0) {
    throw new Error('Direct Codex Worker smoke leaked an account request slot.');
  }
  console.log(`Native Codex ${codexWorker ? 'direct Worker' : responses ? 'Responses' : 'Anthropic'} upstream smoke passed: ${calls} requests, shell tool round trip, final streamed response.`);
} finally {
  if (frontend) { frontend.closeAllConnections(); await new Promise((resolve) => frontend.close(resolve)); }
  await mf?.dispose(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
  await rm(working, { recursive: true, force: true });
}
