import { defineConfig } from "drizzle-kit";
export default defineConfig({ schema: ["./src/db/schema.ts", "./src/db/proxy-schema.ts"], out: "./migrations", dialect: "sqlite" });
