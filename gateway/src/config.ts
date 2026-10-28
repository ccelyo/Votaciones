// Configuración del Gateway, leída de variables de entorno.

import type { RateLimits } from "./rateLimit.ts";
import type { ServiceName } from "./routes.ts";

/**
 * - `jwt`: el Gateway valida el JWT emitido por Auth y aplica los roles.
 * - `passthrough`: transición mientras Auth no emite JWT. Exige un Bearer y
 *   delega su validación y la de los roles en el servicio de destino.
 */
export type AuthMode = "jwt" | "passthrough";

export interface GatewayConfig {
  port: number;
  upstreams: Partial<Record<ServiceName, string>>;
  authMode: AuthMode;
  jwtSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  allowedOrigins: string[];
  rateLimits: RateLimits;
  /** Toma la IP del cliente de X-Forwarded-For (cuando hay un proxy de confianza delante). */
  trustForwardedFor: boolean;
  upstreamTimeoutMs: number;
  maxBodyBytes: number;
}

const SERVICES: ServiceName[] = [
  "auth",
  "election",
  "identity",
  "ballot",
  "tally",
  "analytics",
  "notifications",
];

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} debe ser un entero >= 0`);
  return value;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const upstreams: Partial<Record<ServiceName, string>> = {};
  for (const service of SERVICES) {
    const url = env[`GATEWAY_${service.toUpperCase()}_URL`]?.trim();
    if (url) upstreams[service] = new URL(url).toString().replace(/\/+$/, "");
  }

  const jwtSecret = env.GATEWAY_JWT_SECRET?.trim() || undefined;
  const authMode = (env.GATEWAY_AUTH_MODE?.trim() || (jwtSecret ? "jwt" : "passthrough")) as AuthMode;
  if (authMode !== "jwt" && authMode !== "passthrough") {
    throw new Error("GATEWAY_AUTH_MODE debe ser jwt o passthrough");
  }
  if (authMode === "jwt" && !jwtSecret) {
    throw new Error("GATEWAY_AUTH_MODE=jwt requiere GATEWAY_JWT_SECRET");
  }

  return {
    port: integer(env, "GATEWAY_PORT", 8088),
    upstreams,
    authMode,
    jwtSecret,
    jwtIssuer: env.GATEWAY_JWT_ISSUER?.trim() || undefined,
    jwtAudience: env.GATEWAY_JWT_AUDIENCE?.trim() || undefined,
    allowedOrigins: list(env.GATEWAY_ALLOWED_ORIGINS),
    rateLimits: {
      login: integer(env, "GATEWAY_RATE_LIMIT_LOGIN", 20),
      default: integer(env, "GATEWAY_RATE_LIMIT_DEFAULT", 300),
      ballot: integer(env, "GATEWAY_RATE_LIMIT_BALLOT", 600),
    },
    trustForwardedFor: env.GATEWAY_TRUST_FORWARDED_FOR === "true",
    upstreamTimeoutMs: integer(env, "GATEWAY_UPSTREAM_TIMEOUT_MS", 10_000),
    maxBodyBytes: integer(env, "GATEWAY_MAX_BODY_BYTES", 1024 * 1024),
  };
}
