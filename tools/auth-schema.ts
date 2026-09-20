// Schema generation only: no external database or credentials are used.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { authOptions } from "../src/auth-options";

export const auth = betterAuth({
  ...authOptions({ baseURL: "http://localhost:8787", secret: "schema-generation-only-not-a-runtime-secret",
    clientId: "schema-only", clientSecret: "schema-only", allowedIds: "" }),
  database: drizzleAdapter(drizzle(async () => ({ rows: [] })), { provider: "sqlite" }),
});
