// Configuración del Gateway, leída de variables de entorno.

import type { RateLimits } from "./rateLimit.ts";
import type { ServiceName } from "./routes.ts";

/**
 * - `jwt`: el Gateway valida el JWT RS256 de identity con su JWKS y aplica los roles.
 * - `passthrough`: solo desarrollo, sin JWKS configurado. Exige un Bearer y
 *   delega su validación y la de los roles en el servicio de destino.
 */
export type AuthMode = "jwt" | "passthrough";

/**
 * - `identity`: mediación completa. Cada petición autenticada se revalida contra la
 *   sesión vigente en identity (`GET /auth/me`): revocación, usuario activo y rol actual.
 * - `off`: solo se valida el JWT sin estado (por defecto, para pruebas y desarrollo).
 */
export type SessionCheck = "identity" | "off";

export interface GatewayConfig {
  port: number;
  upstreams: Partial<Record<ServiceName, string>>;
  tlsRequired: boolean;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  tlsClientCaFile?: string;
  upstreamTlsRequired: boolean;
  upstreamTlsCaFile?: string;
  upstreamTlsCertFile?: string;
  upstreamTlsKeyFile?: string;
  authMode: AuthMode;
  /** URL del JWKS de identity, p. ej. https://identity:8000/.well-known/jwks.json. */
  jwksUrl?: string;
  jwtIssuer: string;
  jwtAudience: string;
  allowedOrigins: string[];
  rateLimits: RateLimits;
  /** Toma la IP del cliente de X-Forwarded-For (cuando hay un proxy de confianza delante). */
  trustForwardedFor: boolean;
  upstreamTimeoutMs: number;
  maxBodyBytes: number;
  sessionCheck: SessionCheck;
  /** Tiempo que se reutiliza una sesión ya comprobada en identity. */
  sessionCacheTtlMs: number;
  sessionCacheMax: number;
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
  const tlsRequired = env.GATEWAY_TLS_REQUIRED === "true";
  const upstreamTlsRequired = env.GATEWAY_UPSTREAM_TLS_REQUIRED === "true";
  const tlsCertFile = env.GATEWAY_TLS_CERT_FILE?.trim();
  const tlsKeyFile = env.GATEWAY_TLS_KEY_FILE?.trim();
  const tlsClientCaFile = env.GATEWAY_TLS_CLIENT_CA_FILE?.trim();
  const upstreamTlsCaFile = env.GATEWAY_UPSTREAM_TLS_CA_FILE?.trim();
  const upstreamTlsCertFile = env.GATEWAY_UPSTREAM_TLS_CERT_FILE?.trim();
  const upstreamTlsKeyFile = env.GATEWAY_UPSTREAM_TLS_KEY_FILE?.trim();

  if (tlsRequired && (!tlsCertFile || !tlsKeyFile || !tlsClientCaFile)) {
    throw new Error("GATEWAY_TLS_REQUIRED needs TLS_CERT_FILE, TLS_KEY_FILE and TLS_CLIENT_CA_FILE");
  }
  if (upstreamTlsRequired) {
    if (!upstreamTlsCaFile || !upstreamTlsCertFile || !upstreamTlsKeyFile) {
      throw new Error("GATEWAY_UPSTREAM_TLS_REQUIRED needs UPSTREAM_TLS_CA_FILE, UPSTREAM_TLS_CERT_FILE and UPSTREAM_TLS_KEY_FILE");
    }
    for (const [service, url] of Object.entries(upstreams)) {
      if (new URL(url).protocol !== "https:") {
        throw new Error(`GATEWAY_${service.toUpperCase()}_URL must use https when upstream mTLS is required`);
      }
    }
  }

  if (env.GATEWAY_JWT_SECRET?.trim()) {
    // Evita que un despliegue antiguo crea que sigue validando con HS256.
    throw new Error("GATEWAY_JWT_SECRET ya no se usa: el JWT es RS256, define GATEWAY_JWKS_URL");
  }
  const jwksUrl = env.GATEWAY_JWKS_URL?.trim() ? new URL(env.GATEWAY_JWKS_URL.trim()).toString() : undefined;
  const authMode = (env.GATEWAY_AUTH_MODE?.trim() || (jwksUrl ? "jwt" : "passthrough")) as AuthMode;
  if (authMode !== "jwt" && authMode !== "passthrough") {
    throw new Error("GATEWAY_AUTH_MODE debe ser jwt o passthrough");
  }
  if (authMode === "jwt" && !jwksUrl) {
    throw new Error("GATEWAY_AUTH_MODE=jwt requiere GATEWAY_JWKS_URL");
  }

  const sessionCheck = (env.GATEWAY_SESSION_CHECK?.trim() || "off") as SessionCheck;
  if (sessionCheck !== "identity" && sessionCheck !== "off") {
    throw new Error("GATEWAY_SESSION_CHECK debe ser identity u off");
  }
  if (sessionCheck === "identity") {
    if (!upstreams.auth) throw new Error("GATEWAY_SESSION_CHECK=identity requiere GATEWAY_AUTH_URL");
    if (authMode !== "jwt") throw new Error("GATEWAY_SESSION_CHECK=identity requiere GATEWAY_AUTH_MODE=jwt");
  }

  return {
    port: integer(env, "GATEWAY_PORT", 8088),
    upstreams,
    tlsRequired,
    tlsCertFile,
    tlsKeyFile,
    tlsClientCaFile,
    upstreamTlsRequired,
    upstreamTlsCaFile,
    upstreamTlsCertFile,
    upstreamTlsKeyFile,
    authMode,
    jwksUrl,
    // Valores que emite identity (IDENTITY_JWT_ISSUER / IDENTITY_JWT_AUDIENCE).
    jwtIssuer: env.GATEWAY_JWT_ISSUER?.trim() || "votaciones-identity",
    jwtAudience: env.GATEWAY_JWT_AUDIENCE?.trim() || "votaciones",
    allowedOrigins: list(env.GATEWAY_ALLOWED_ORIGINS),
    rateLimits: {
      login: integer(env, "GATEWAY_RATE_LIMIT_LOGIN", 20),
      default: integer(env, "GATEWAY_RATE_LIMIT_DEFAULT", 300),
      ballot: integer(env, "GATEWAY_RATE_LIMIT_BALLOT", 600),
    },
    trustForwardedFor: env.GATEWAY_TRUST_FORWARDED_FOR === "true",
    upstreamTimeoutMs: integer(env, "GATEWAY_UPSTREAM_TIMEOUT_MS", 10_000),
    maxBodyBytes: integer(env, "GATEWAY_MAX_BODY_BYTES", 1024 * 1024),
    sessionCheck,
    sessionCacheTtlMs: integer(env, "GATEWAY_SESSION_CACHE_TTL_MS", 5_000),
    sessionCacheMax: Math.max(1, integer(env, "GATEWAY_SESSION_CACHE_MAX", 10_000)),
  };
}
