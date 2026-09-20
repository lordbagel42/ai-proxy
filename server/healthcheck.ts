import { loadRuntimeConfig } from "./config";

try {
  const { port } = loadRuntimeConfig();
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
  process.exit(response.ok ? 0 : 1);
} catch { process.exit(1); }
