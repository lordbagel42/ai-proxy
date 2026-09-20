// Fetch the same account-backed catalog displayed in the dashboard.
export async function fetchModelCatalog(saved, fetcher = fetch) {
  const response = await fetcher(`${saved.url}/v1/models`, {
    headers: { authorization: `Bearer ${saved.key}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message ?? `Cannot load gateway models (HTTP ${response.status}).`);
  }
  let text = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > 8_388_608) throw new Error('The gateway model catalog is too large.');
  }
  text += decoder.decode();
  let catalog;
  try { catalog = JSON.parse(text); } catch { throw new Error('The gateway returned an invalid model catalog.'); }
  if (!Array.isArray(catalog.data) || !catalog.data.length || catalog.data.some((model) => typeof model.id !== 'string' || !model.id)) {
    throw new Error('The gateway has no available models. Connect a provider in the dashboard first.');
  }
  if (!Array.isArray(catalog.models) || catalog.models.some((model) => typeof model.slug !== 'string')) {
    throw new Error('The gateway did not return Codex model metadata. Update the gateway before connecting this client.');
  }
  return catalog;
}

export function selectModel(catalog, requested) {
  // Older setup snippets used the `codex` alias. Preserve them when the new
  // account-backed catalog exposes actual model IDs instead.
  const legacyAlias = requested === 'codex' && !catalog.data.some((entry) => entry.id === 'codex') && catalog.models.length > 0;
  const model = (legacyAlias ? undefined : requested) ?? catalog.default_model ?? catalog.data[0].id;
  if (!catalog.data.some((entry) => entry.id === model)) {
    throw new Error(`Model ${model} is unavailable. Available models: ${catalog.data.map((entry) => entry.id).join(', ')}.`);
  }
  return model;
}

export function codexConfig(url, model, catalogPath) {
  return {
    model_provider: 'friends_proxy', model, ...(catalogPath ? { model_catalog_json: catalogPath } : {}),
    'model_providers.friends_proxy.name': 'Friends AI Proxy',
    'model_providers.friends_proxy.base_url': `${url}/v1`,
    'model_providers.friends_proxy.env_key': 'AI_PROXY_API_KEY',
    'model_providers.friends_proxy.wire_api': 'responses',
    web_search: 'disabled',
  };
}
