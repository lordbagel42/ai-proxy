import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { authOptions } from "./auth-options";
import * as schema from "./db/schema";
import type { AppEnv } from "./env";
import { ApiError } from "./core/errors";

export function createAuth(env: AppEnv) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32 || !env.HACKCLUB_CLIENT_ID || !env.HACKCLUB_CLIENT_SECRET) {
    throw new ApiError(503, "Hack Club authentication is not configured.", "configuration_error");
  }
  return betterAuth({
    ...authOptions({ baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET,
      clientId: env.HACKCLUB_CLIENT_ID, clientSecret: env.HACKCLUB_CLIENT_SECRET, allowedIds: env.ALLOWED_HACKCLUB_IDS }),
    database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite", schema, transaction: false }),
  });
}
