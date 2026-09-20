import { codexModelCatalog, type CodexModelInfo } from "./codex/models";
import { ApiError } from "./core/errors";
import type { AppEnv } from "./env";
import { configuredProviders, type ProviderDefinition } from "./providers";

interface ModelRoute { id: string; config: ProviderDefinition; upstreamModel: string }
export interface ModelListing {
  object: "list";
  data: { id: string; object: "model"; created: number; owned_by: string }[];
  models: CodexModelInfo[];
  default_model: string | null;
}

async function registry(env: AppEnv, ctx: ExecutionContext, signal?: AbortSignal) {
  const routes: ModelRoute[] = [];
  const native: CodexModelInfo[] = [];
  let defaultModel: string | null = null;
  for (const config of configuredProviders(env.PROVIDERS_JSON)) {
    for (const [id, upstreamModel] of Object.entries(config.models)) {
      if (routes.some((route) => route.id === id)) {
        throw new ApiError(503, "A configured alias conflicts with a discovered model.", "configuration_error");
      }
      routes.push({ id, upstreamModel, config });
    }
    if (config.protocol !== "codex" || !config.discoverModels) continue;
    const catalog = await codexModelCatalog(env, ctx, { signal });
    defaultModel ??= catalog.defaultModel;
    for (const model of catalog.models) {
      const existing = routes.find((route) => route.id === model.slug);
      if (existing && (existing.config.id !== config.id || existing.upstreamModel !== model.slug)) {
        throw new ApiError(503, "A configured alias conflicts with a discovered model.", "configuration_error");
      }
      if (!existing) routes.push({ id: model.slug, upstreamModel: model.slug, config });
      // The native client authenticates to this gateway with an API key. These
      // subscription models are available through our API, regardless of their
      // availability through OpenAI's separately billed API.
      native.push({ ...model, supported_in_api: true });
    }
  }
  return { routes, native, defaultModel: defaultModel ?? routes.find((route) => !(route.config.protocol === "codex" && route.config.discoverModels))?.id ?? null };
}

export async function modelListing(env: AppEnv, ctx: ExecutionContext, signal?: AbortSignal): Promise<ModelListing> {
  const result = await registry(env, ctx, signal);
  return { object: "list", data: result.routes.map(({ id, config }) => ({ id, object: "model", created: 0, owned_by: config.id })),
    models: result.native, default_model: result.defaultModel };
}

export async function resolveModel(env: AppEnv, ctx: ExecutionContext, model: string, signal?: AbortSignal): Promise<ModelRoute> {
  const providers = configuredProviders(env.PROVIDERS_JSON);
  const configured = providers.find((p) => Object.hasOwn(p.models, model));
  if (configured) return { id: model, config: configured, upstreamModel: configured.models[model]! };
  const result = await registry(env, ctx, signal);
  const route = result.routes.find((candidate) => candidate.id === model);
  if (route) return route;
  // Existing client installations used this alias before discovery was added.
  if (model === "codex" && result.defaultModel) {
    const fallback = result.routes.find((candidate) => candidate.id === result.defaultModel && candidate.config.protocol === "codex");
    if (fallback) return fallback;
  }
  throw new ApiError(400, "Unknown model. Use GET /v1/models to list available models.");
}
