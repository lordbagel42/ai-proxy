import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir("dist-server", { recursive: true });
const result = await build({
  entryPoints: ["server/main.ts", "server/db-cli.ts", "server/healthcheck.ts"],
  outdir: "dist-server", outExtension: { ".js": ".mjs" },
  platform: "node", target: "node22.23", format: "esm", bundle: true,
  sourcemap: false, metafile: true, logLevel: "info",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
await writeFile("dist-server/build-meta.json", JSON.stringify(result.metafile));
