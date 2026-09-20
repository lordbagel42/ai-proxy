// Runs inside Docker only. Never mount an upstream credential or a host Codex home.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { selectModel } from '../bin/codex-models.mjs';

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name} value.`);
  args.splice(i, 2); return value;
}
const live = args.includes('--live');
if (live) args.splice(args.indexOf('--live'), 1);
const origin = option('--url');
const keyPath = option('--key-file');
const requestedModel = option('--model');
if (!live || !origin || !keyPath || args.length) throw new Error('Explicit --live, --url, and --key-file are required.');
const key = (await readFile(keyPath, 'utf8')).trim();
if (!/^ap_[a-f0-9]{64}$/.test(key)) throw new Error('Invalid gateway API key file.');
const working = await mkdtemp('/tmp/ai-proxy-e2e-');
const home = join(working, 'home');
const workspace = join(working, 'workspace');
await mkdir(home, { mode: 0o700 });
await mkdir(workspace, { mode: 0o700 });
const childEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config'), LANG: 'C.UTF-8' };
await mkdir(childEnv.CODEX_HOME, { mode: 0o700 });
await mkdir(join(childEnv.XDG_CONFIG_HOME, 'ai-proxy'), { recursive: true, mode: 0o700 });
await writeFile(join(childEnv.XDG_CONFIG_HOME, 'ai-proxy', 'credentials.json'), JSON.stringify({ url: origin, key }), { mode: 0o600 });
const failures = [];
const results = [];
const skipped = [];
const marker = 'relay-integration-ok';
function sanitize(text) {
  return String(text).replaceAll(key, '[redacted]').replace(/ap_[a-f0-9]{64}/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1500);
}
async function test(name, fn) {
  const start = Date.now();
  try { const detail = await fn(); results.push(name); console.log(JSON.stringify({ test: name, status: 'passed', ms: Date.now() - start, ...detail })); }
  catch (error) { failures.push(name); console.log(JSON.stringify({ test: name, status: 'failed', ms: Date.now() - start, error: sanitize(error.message) })); }
}
async function request(path, body, anthropic = false) {
  const headers = { ...(anthropic ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` }), ...(body ? { 'content-type': 'application/json' } : {}) };
  const response = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET', headers,
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(150_000) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`HTTP ${response.status} ${path}: ${data.error?.message ?? 'request failed'}`);
  }
  return response;
}
async function events(response) {
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  // Test prompts are tiny. Bound buffered output even if the upstream misbehaves.
  let text = '';
  for await (const chunk of response.body) {
    text += new TextDecoder().decode(chunk);
    if (text.length > 1_048_576) throw new Error('Integration response exceeded 1 MiB.');
  }
  const data = text.split(/\r?\n\r?\n/).flatMap((frame) => {
    const raw = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    return !raw ? [] : raw === '[DONE]' ? ['[DONE]'] : [JSON.parse(raw)];
  });
  for (const event of data) if (event?.error || event?.type === 'response.failed') {
    throw new Error(`Stream failed: ${event.error?.message ?? event.response?.error?.message ?? 'upstream error'}`);
  }
  return data;
}
let model = requestedModel;
let advertisedIds = [];
let pickerIds = [];
let discovered = false;
try {
  await test('authenticated model discovery', async () => {
    const catalog = await (await request('/v1/models')).json();
    assert.equal(catalog.object, 'list');
    assert.ok(Array.isArray(catalog.data) && catalog.data.length > 0, 'No available models returned.');
    advertisedIds = catalog.data.map((entry) => entry.id);
    pickerIds = catalog.models?.filter((entry) => entry.visibility === 'list').map((entry) => entry.slug) ?? [];
    model = selectModel({ ...catalog, models: catalog.models ?? [] }, requestedModel);
    assert.ok(advertisedIds.every((id) => typeof id === 'string' && id.length > 0));
    assert.equal(new Set(advertisedIds).size, advertisedIds.length, 'Duplicate model IDs.');
    assert.ok(advertisedIds.includes(model), `Requested model ${model} is not in the catalog.`);
    assert.ok(advertisedIds.some((id) => id !== 'codex'), 'The catalog contains only the old codex alias instead of upstream model IDs.');
    discovered = true;
    return { models: advertisedIds, selected: model };
  });
  if (discovered) {
    await test('native Codex model picker', async () => {
      const child = spawn(process.execPath, ['/opt/ai-proxy/bin/ai-proxy.mjs', 'codex', '--model', model, 'app-server'],
        { env: childEnv, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let response;
      const requests = new Map();
      child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 1_048_576) child.kill('SIGKILL'); });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        let newline;
        while ((newline = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
          try {
            const data = JSON.parse(line);
            if (requests.has(data.id)) { requests.get(data.id)(data); requests.delete(data.id); }
          } catch { /* Native informational lines are not protocol responses. */ }
        }
      });
      const closed = new Promise((resolve) => child.once('exit', resolve));
      child.once('error', () => {});
      const deadline = new Promise((_, reject) => {
        response = setTimeout(() => reject(new Error(`Native model/list timed out. ${sanitize(stderr)}`)), 40_000);
      });
      const rpc = (id, method, params) => {
        const reply = new Promise((resolve) => requests.set(id, resolve));
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        return Promise.race([reply, deadline, closed.then((code) => { throw new Error(`Native model/list exited ${code}. ${sanitize(stderr)}`); })]);
      };
      try {
        const initialized = await rpc(1, 'initialize', { clientInfo: { name: 'ai-proxy-integration', version: '1.0.0' } });
        assert.ok(initialized.result, `App-server initialize failed: ${sanitize(JSON.stringify(initialized.error))}`);
        child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        const listed = await rpc(2, 'model/list', { limit: 100 });
        assert.ok(!listed.error, `App-server model/list failed: ${sanitize(JSON.stringify(listed.error))}`);
        const ids = listed.result?.data?.map((entry) => entry.model);
        assert.ok(Array.isArray(ids) && ids.length > 0, 'Native model picker is empty.');
        assert.ok(pickerIds.length > 0, 'Gateway did not return native picker metadata.');
        assert.deepEqual([...ids].sort(), [...pickerIds].sort(), 'Native model picker differs from gateway catalog.');
        return { models: ids };
      } finally { clearTimeout(response); child.stdin.end(); child.kill('SIGTERM'); await closed; }
    });
    for (const stream of [false, true]) {
      await test(`Responses ${stream ? 'stream' : 'JSON'}`, async () => {
        const response = await request('/v1/responses', { model, input: `Reply with exactly ${marker}.`, max_output_tokens: 128, stream, store: false });
        let data;
        if (stream) {
          const parts = await events(response);
          assert.ok(parts.some((part) => part.type === 'response.output_text.delta'), 'No streamed text delta.');
          data = parts.find((part) => part.type === 'response.completed')?.response;
        } else data = await response.json();
        assert.equal(data?.status, 'completed');
        assert.ok(data.output.flatMap((item) => item.content ?? []).some((part) => part.text?.includes(marker)), 'Missing expected synthetic reply.');
        assert.ok(data.usage?.input_tokens > 0 && data.usage?.output_tokens > 0, 'Token usage is missing.');
        return { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens };
      });
      await test(`Chat Completions ${stream ? 'stream' : 'JSON'}`, async () => {
        const response = await request('/v1/chat/completions', { model, messages: [{ role: 'user', content: `Reply with exactly ${marker}.` }], max_completion_tokens: 128, stream });
        if (stream) {
          const parts = await events(response);
          assert.equal(parts.at(-1), '[DONE]');
          assert.ok(parts.map((part) => part.choices?.[0]?.delta?.content ?? '').join('').includes(marker), 'Missing streamed synthetic reply.');
          const usage = parts.find((part) => part.usage)?.usage;
          assert.ok(usage?.prompt_tokens > 0 && usage?.completion_tokens > 0, 'Token usage is missing.');
        } else {
          const data = await response.json();
          assert.equal(data.object, 'chat.completion');
          assert.ok(data.choices?.[0]?.message?.content?.includes(marker), 'Missing synthetic reply.');
          assert.ok(data.usage?.prompt_tokens > 0 && data.usage?.completion_tokens > 0, 'Token usage is missing.');
        }
      });
      await test(`Anthropic Messages ${stream ? 'stream' : 'JSON'}`, async () => {
        const response = await request('/v1/messages', { model, messages: [{ role: 'user', content: `Reply with exactly ${marker}.` }], max_tokens: 128, stream }, true);
        if (stream) {
          const parts = await events(response);
          assert.equal(parts.at(-1)?.type, 'message_stop');
          assert.ok(parts.filter((part) => part.type === 'content_block_delta').map((part) => part.delta?.text ?? '').join('').includes(marker), 'Missing streamed synthetic reply.');
          assert.ok(parts.find((part) => part.type === 'message_delta')?.usage?.output_tokens > 0, 'Token usage is missing.');
        } else {
          const data = await response.json();
          assert.equal(data.type, 'message');
          assert.ok(data.content?.some((part) => part.text?.includes(marker)), 'Missing synthetic reply.');
          assert.ok(data.usage?.output_tokens > 0, 'Token usage is missing.');
        }
      });
    }
    await test('native Codex shell tool round trip', async () => {
      const child = spawn(process.execPath, ['/opt/ai-proxy/bin/ai-proxy.mjs', 'codex', '--model', model, 'exec',
        '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never',
        '--dangerously-bypass-approvals-and-sandbox', '-C', workspace,
        '-c', 'model_reasoning_effort="low"', '-c', 'model_providers.friends_proxy.request_max_retries=0',
        '-c', 'model_providers.friends_proxy.stream_max_retries=0',
        'This is a synthetic integration test. Use a shell tool to write the exact text relay-tool-ok to proof.txt in the current workspace, then use a shell tool to read proof.txt. After reading that file, reply with exactly relay-native-ok. Do not inspect environment variables, credentials, or any paths outside this workspace.'],
      { env: childEnv, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 1_048_576) child.kill('SIGKILL'); });
      child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 1_048_576) child.kill('SIGKILL'); });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 210_000);
      const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      clearTimeout(timeout);
      if (exitCode !== 0) throw new Error(`Codex exited ${exitCode}: ${sanitize(stderr)} ${sanitize(stdout)}`);
      const messages = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const completed = messages.filter((event) => event.type === 'item.completed');
      assert.ok(completed.some((event) => event.item?.type === 'command_execution' && event.item?.exit_code === 0), `No successful command_execution event. ${sanitize(stderr)}`);
      assert.equal((await readFile(join(workspace, 'proof.txt'), 'utf8')).trim(), 'relay-tool-ok');
      assert.ok(completed.some((event) => event.item?.type === 'agent_message' && event.item?.text?.includes('relay-native-ok')), 'Missing final native Codex reply.');
      assert.ok(messages.some((event) => event.type === 'turn.completed'), 'Native turn did not complete.');
      assert.ok(!/fallback model metadata|unknown model|not supported/i.test(stderr), `Native model metadata was not recognized. ${sanitize(stderr)}`);
      return { model, commands: completed.filter((event) => event.item?.type === 'command_execution').length };
    });
  } else {
    for (const name of ['native Codex model picker',
      'Responses JSON', 'Chat Completions JSON', 'Anthropic Messages JSON',
      'Responses stream', 'Chat Completions stream', 'Anthropic Messages stream',
      'native Codex shell tool round trip']) {
      skipped.push(name);
      console.log(JSON.stringify({ test: name, status: 'skipped', reason: 'Authenticated model discovery failed; a working upstream connection is required.' }));
    }
  }
  console.log(JSON.stringify({ summary: { passed: results.length, failed: failures.length, skipped: skipped.length, failures } }));
  if (failures.length) process.exitCode = 1;
} finally {
  await rm(working, { recursive: true, force: true });
}
