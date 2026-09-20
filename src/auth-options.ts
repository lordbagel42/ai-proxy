import type { BetterAuthOptions } from "better-auth";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { z } from "zod";

export function allowedIdentities(value: string): Set<string> {
  return new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
}

const identity = z.object({ identity: z.object({
  id: z.string().min(1), primary_email: z.email(), first_name: z.string().nullable().optional(), last_name: z.string().nullable().optional(),
}) });

export function authOptions(config: { baseURL: string; secret: string; clientId: string; clientSecret: string; allowedIds: string }): BetterAuthOptions {
  return {
    appName: "Friends AI Proxy",
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: [new URL(config.baseURL).origin],
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: new URL(config.baseURL).protocol === "https:", ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    plugins: [genericOAuth({ config: [{
      providerId: "hackclub", clientId: config.clientId, clientSecret: config.clientSecret,
      authorizationUrl: "https://auth.hackclub.com/oauth/authorize", tokenUrl: "https://auth.hackclub.com/oauth/token",
      scopes: ["email", "name"], pkce: true,
      async getUserInfo(tokens) {
        const response = await fetch("https://auth.hackclub.com/api/v1/me", {
          headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(10_000), redirect: "manual",
        });
        if (!response.ok) return null;
        const parsed = identity.safeParse(await response.json());
        // Authentication establishes an immutable Hack Club identity. Membership
        // is checked separately so invitees can sign in before accepting access.
        if (!parsed.success) return null;
        const user = parsed.data.identity;
        return { id: user.id, email: user.primary_email, emailVerified: false,
          name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.primary_email };
      },
    }] })],
  };
}
