import { CLIENT_USER_AGENT, codexRejection } from "./http";
import { z } from "zod";
import { ApiError } from "../core/errors";
import type { AppEnv } from "../env";
import { codexCredentials, markConnectionRejected, type CredentialSnapshot } from "./connection";

const CLIENT_VERSION = "0.154.0";
const MODEL_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CLIENT_VERSION}`;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CACHE_AGE_MS = 5 * 60_000;
const unavailable = (status?: number, html = false) => new ApiError(502,
  status ? `The ChatGPT model catalog returned HTTP ${status}${html ? " (HTML response)" : ""}.` : "The ChatGPT model catalog is unavailable. Try again shortly.", "codex_models_unavailable");
const invalidCatalog = () => new ApiError(502, "ChatGPT returned an invalid model catalog.", "codex_models_invalid");

const text = z.string().max(MAX_BODY_BYTES);
const optionalText = text.nullish();
const toolMessage = z.object({ description: optionalText, parameters: optionalText }).nullish();
const guardianMode = z.string().max(40).nullish();
const instructions = z.object({
  instructions_template: optionalText,
  instructions_variables: z.object({ personality_default: optionalText, personality_friendly: optionalText, personality_pragmatic: optionalText }).nullish(),
  persistent_instructions: optionalText,
  tools: z.object({ send_user_message_async: toolMessage, multi_agent: z.object({ spawn_agent: toolMessage, send_message: toolMessage, followup_task: toolMessage, wait_agent: toolMessage, interrupt_agent: toolMessage, list_agents: toolMessage }).nullish() }).nullish(),
  approvals: z.object({ on_request: optionalText, on_request_auto_review: optionalText, never: optionalText, unless_trusted: optionalText }).nullish(),
  collaboration_modes: z.object({ default: optionalText, plan: optionalText }).nullish(),
  auto_review: z.object({ policy: optionalText, policy_template: optionalText, node_repl_policy: optionalText, rejection_instructions: optionalText, timeout_instructions: optionalText }).nullish(),
  permissions: z.object({ danger_full_access: optionalText, workspace_write: optionalText, read_only: optionalText }).nullish(),
  multi_agent: z.object({ role: z.object({ root: optionalText, subagent: optionalText }).nullish(), mode: z.object({ explicit: optionalText, proactive: optionalText, hint_text: optionalText }).nullish() }).nullish(),
  confirmation_policies: z.object({ browser_use: optionalText, computer_use: optionalText }).nullish(),
  token_budget: z.object({ enabled: z.boolean().optional(), use_history_notes_extension: z.boolean().optional(), reminder_threshold_tokens: z.number().int(), reminder_message_template: text, guidance_message: text, auto_compact_fallback_prompt: text, auto_compact_fallback_buffer_tokens: z.number().int() }).nullish(),
  guardian_v2: z.object({
    classifier_instructions: optionalText, review_threshold_basis_points: z.number().int().nonnegative().nullish(), max_tool_call_lag: z.number().int().nonnegative().nullish(), reasoning_effort: z.string().max(40).nullish(),
    max_action_tokens: z.number().int().nonnegative().nullish(), max_classifier_instruction_tokens: z.number().int().nonnegative().nullish(), reuse_parent_compaction: z.boolean().nullish(), max_parent_compaction_tokens: z.number().int().nonnegative().nullish(),
    transcript: z.object({ sources: z.array(z.string().max(100)).max(32).nullish(), include_images: z.boolean().nullish(), max_message_entry_tokens: z.number().int().nonnegative().nullish(), max_tool_entry_tokens: z.number().int().nonnegative().nullish(), max_message_transcript_tokens: z.number().int().nonnegative().nullish(), max_tool_transcript_tokens: z.number().int().nonnegative().nullish(), max_recent_non_user_entries: z.number().int().nonnegative().nullish() }).nullish(),
  }).nullish(),
});

// This is the native ModelInfo wire format, rather than OpenAI's minimal data[].
// Explicit fields prevent provider/account metadata from reaching members. All
// required capabilities come from discovery; there is no invented model list.
const modelSchema = z.object({
  guardian: z.object({ computer_use: guardianMode, shell: guardianMode, code_mode: guardianMode, file_changes: guardianMode, mcp: guardianMode, network: guardianMode, permissions: guardianMode }).nullish(),
  slug: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  display_name: z.string().min(1).max(500),
  description: text.nullish(),
  default_reasoning_level: z.string().min(1).max(40).nullish(),
  supported_reasoning_levels: z.array(z.object({ effort: z.string().min(1).max(40), description: text })).max(32),
  shell_type: z.enum(["unified_exec", "disabled", "default", "local", "shell_command"]),
  visibility: z.enum(["list", "hide", "none"]),
  supported_in_api: z.boolean(),
  priority: z.number().int(),
  additional_speed_tiers: z.array(z.string().max(100)).max(32).optional(),
  service_tiers: z.array(z.object({ id: z.string().max(100), name: z.string().max(500), description: text })).max(32).optional(),
  default_service_tier: z.string().max(100).nullish(),
  availability_nux: z.object({ message: text }).nullish(),
  upgrade: z.object({ model: z.string().max(200), migration_markdown: text, retirement_at: optionalText }).nullish(),
  base_instructions: optionalText,
  model_messages: instructions.nullish(),
  include_skills_usage_instructions: z.boolean().optional(),
  include_plugin_usage_instructions: z.boolean().optional(),
  include_apps_usage_instructions: z.boolean().optional(),
  supports_reasoning_summary_parameter: z.boolean().optional(),
  default_reasoning_summary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
  support_verbosity: z.boolean(),
  default_verbosity: z.enum(["low", "medium", "high"]).nullish(),
  apply_patch_tool_type: z.enum(["freeform"]).nullish(),
  web_search_tool_type: z.enum(["text", "text_and_image"]).optional(),
  truncation_policy: z.object({ mode: z.enum(["bytes", "tokens"]), limit: z.number().int().nonnegative() }),
  supports_image_detail_original: z.boolean().optional(),
  context_window: z.number().int().positive().nullish(),
  max_context_window: z.number().int().positive().nullish(),
  auto_compact_token_limit: z.number().int().positive().nullish(),
  comp_hash: z.string().max(1_000).nullish(),
  effective_context_window_percent: z.number().int().min(1).max(100).optional(),
  experimental_supported_tools: z.array(z.string().max(200)).max(128),
  input_modalities: z.array(z.enum(["text", "image", "audio"])).max(3).optional(),
  supports_search_tool: z.boolean().optional(),
  supports_experimental_context: z.boolean().optional(),
  use_responses_lite: z.boolean().optional(),
  supports_reasoning_effort_updates: z.boolean().optional(),
  node_repl_auto_review_required: z.boolean().optional(),
  node_repl_disabled: z.boolean().optional(),
  auto_review_model_override: z.string().max(200).nullish(),
  model_specialty: z.string().max(100).nullish(),
  tool_mode: z.enum(["direct", "code_mode", "code_mode_only"]).nullish(),
  multi_agent_version: z.string().max(40).nullish(),
  multi_agent_reasoning_effort: z.string().max(40).nullish(),
});

export type CodexModelInfo = z.infer<typeof modelSchema>;
export interface CodexModelCatalog { models: CodexModelInfo[]; defaultModel: string | null; fetchedAt: number }

export function parseCodexModels(value: unknown): CodexModelInfo[] {
  const result = z.object({ models: z.array(modelSchema).max(256) }).safeParse(value);
  if (!result.success) throw invalidCatalog();
  const slugs = new Set<string>();
  for (const model of result.data.models) {
    if (slugs.has(model.slug)) throw invalidCatalog();
    slugs.add(model.slug);
  }
  return result.data.models.sort((a, b) => a.priority - b.priority);
}

function catalog(models: CodexModelInfo[], fetchedAt: number): CodexModelCatalog {
  return { models, fetchedAt, defaultModel: models.find((model) => model.visibility === "list")?.slug ?? null };
}

async function readModels(response: Response, signal: AbortSignal): Promise<CodexModelInfo[]> {
  if (!response.body || signal.aborted) { await response.body?.cancel(); throw unavailable(); }
  const lengthHeader = Number(response.headers.get("content-length"));
  if (Number.isFinite(lengthHeader) && lengthHeader > MAX_BODY_BYTES) { await response.body.cancel(); throw unavailable(); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw unavailable(); }
      chunks.push(value);
    }
    if (signal.aborted) throw unavailable();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
    catch { throw invalidCatalog(); }
    return parseCodexModels(parsed);
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

/** Account-specific native catalog, with an owner/version-fenced D1 cache. */
export async function codexModelCatalog(env: AppEnv, ctx: ExecutionContext, options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<CodexModelCatalog> {
  const credentialsFor = (rejected?: CredentialSnapshot) => {
    const operation = codexCredentials(env, rejected);
    ctx.waitUntil(operation.then(() => {}, () => {}));
    return operation;
  };
  let credentials = await credentialsFor();
  if (!options.forceRefresh) {
    const cached = await env.DB.prepare(`SELECT cache.catalog, cache.fetched_at FROM codex_model_cache cache
      JOIN codex_connection connection ON connection.id = cache.id AND connection.owner_identity = cache.owner_identity
        AND connection.version = cache.connection_version AND connection.credentials IS NOT NULL AND connection.needs_reconnect = 0
      WHERE cache.id = 'codex' AND cache.owner_identity = ? AND cache.connection_version = ? AND cache.expires_at > ?`)
      .bind(env.OWNER_HACKCLUB_ID, credentials.version, Date.now()).first<{ catalog: string; fetched_at: number }>();
    if (cached) {
      try { return catalog(parseCodexModels(JSON.parse(cached.catalog)), cached.fetched_at); }
      catch { /* Refresh invalid or obsolete cache entries from the upstream. */ }
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const send = () => fetch(MODEL_URL, {
    method: "GET", redirect: "manual", signal,
    headers: { accept: "application/json", authorization: `Bearer ${credentials.tokens.accessToken}`,
      "ChatGPT-Account-ID": credentials.tokens.accountId, originator: "codex_cli_rs", "user-agent": CLIENT_USER_AGENT },
  });
  try {
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      credentials = await credentialsFor(credentials);
      response = await send();
    }
    if (!response.ok) {
      if (response.status === 401) { await response.body?.cancel(); }
      if (response.status === 401) {
        await markConnectionRejected(env, credentials.version);
        throw new ApiError(503, "ChatGPT needs to be reconnected by the owner.", "codex_reauthentication_required");
      }
      if (response.status === 429) { await response.body?.cancel(); throw new ApiError(429, "ChatGPT model discovery is busy. Try again shortly.", "rate_limit_error", "5"); }
      const failure = await codexRejection(response, signal, "models");
      if (response.status === 403 || failure.code === "codex_upstream_challenge") throw failure;
      throw unavailable(response.status, response.headers.get("content-type")?.includes("text/html"));
    }
    const models = await readModels(response, signal);
    const fetchedAt = Date.now();
    const result = await env.DB.prepare(`INSERT INTO codex_model_cache (id, owner_identity, connection_version, catalog, fetched_at, expires_at)
      SELECT 'codex', owner_identity, version, ?, ?, ? FROM codex_connection
      WHERE id = 'codex' AND owner_identity = ? AND version = ? AND credentials IS NOT NULL AND needs_reconnect = 0
      ON CONFLICT(id) DO UPDATE SET owner_identity = excluded.owner_identity, connection_version = excluded.connection_version,
        catalog = excluded.catalog, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`)
      .bind(JSON.stringify({ models }), fetchedAt, fetchedAt + CACHE_AGE_MS, env.OWNER_HACKCLUB_ID, credentials.version).run();
    if (!result.meta.changes) throw new ApiError(503, "ChatGPT's connection changed while loading models. Try again.", "codex_busy", "2");
    return catalog(models, fetchedAt);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally { clearTimeout(timer); }
}
