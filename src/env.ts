// Runtime and resource bindings come from `wrangler types`. Widen config literals
// so tests and deployment environments can supply different values.
export type AppEnv = { [K in keyof Env]: Env[K] extends string ? string : Env[K] } & {
  BETTER_AUTH_SECRET: string;
  HACKCLUB_CLIENT_ID: string;
  HACKCLUB_CLIENT_SECRET: string;
  RELAY_SHARED_SECRET?: string;
  CODEX_TOKEN_KEY?: string;
  OWNER_HACKCLUB_ID?: string;
  MAINTENANCE_MODE?: string;
};
