// Validación del JWT de acceso RS256 que emite identity (actividad CR-04).
//
// Contrato con identity (identity/README.md, "JWT de acceso (contrato con el Gateway)"):
// - Cabecera: alg RS256, typ JWT, kid.
// - Claims: iss, aud, sub, username, role, iat, nbf, exp y jti.
// - Clave pública: GET /.well-known/jwks.json en identity.
//
// El Gateway solo tiene claves públicas, así que no puede fabricar tokens: si se
// compromete, no sirve para emitir sesiones de administrador.

import { createPublicKey, type JsonWebKey, type KeyObject, verify } from "node:crypto";

export interface Principal {
  userId: string;
  roles: string[];
}

/** El token no es válido: el cliente recibe 401. */
export class JwtError extends Error {}

/** No se pudo obtener el JWKS: el Gateway no puede decidir y responde 503. */
export class JwksUnavailableError extends Error {}

/** Devuelve la clave pública del `kid`, o `undefined` si identity no la publica. */
export type KeyResolver = (kid: string) => Promise<KeyObject | undefined>;

export interface JwtOptions {
  keys: KeyResolver;
  issuer: string;
  audience: string;
  clockToleranceSeconds?: number;
  now?: () => number;
}

const MIN_RSA_BITS = 2048;

function decodeSegment(segment: string): unknown {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new JwtError("malformed token");
  }
}

export async function verifyJwt(token: string, options: JwtOptions): Promise<Principal> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeSegment(headerSegment) as { alg?: unknown; typ?: unknown; kid?: unknown };
  // Solo RS256: rechaza "none", HS* (confusión de algoritmo con la clave pública) y el resto.
  if (header.alg !== "RS256") throw new JwtError("unsupported algorithm");
  if (header.typ !== undefined && header.typ !== "JWT") throw new JwtError("unsupported token type");
  if (typeof header.kid !== "string" || header.kid === "") throw new JwtError("missing kid");

  const key = await options.keys(header.kid);
  if (!key) throw new JwtError("unknown kid");

  const signature = Buffer.from(signatureSegment, "base64url");
  const valid = verify("sha256", Buffer.from(`${headerSegment}.${payloadSegment}`), key, signature);
  if (!valid) throw new JwtError("invalid signature");

  const claims = decodeSegment(payloadSegment) as Record<string, unknown>;
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const tolerance = options.clockToleranceSeconds ?? 30;

  if (typeof claims.exp !== "number") throw new JwtError("missing exp");
  if (now > claims.exp + tolerance) throw new JwtError("token expired");
  if (claims.nbf !== undefined && typeof claims.nbf !== "number") throw new JwtError("invalid nbf");
  if (typeof claims.nbf === "number" && now + tolerance < claims.nbf) {
    throw new JwtError("token not yet valid");
  }
  if (claims.iss !== options.issuer) throw new JwtError("invalid issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) throw new JwtError("invalid audience");

  const sub = claims.sub;
  if (typeof sub !== "string" || sub === "") throw new JwtError("missing sub");

  let roles: string[] = [];
  if (typeof claims.role === "string") {
    roles = [claims.role];
  } else if (Array.isArray(claims.roles)) {
    roles = claims.roles.filter((r): r is string => typeof r === "string");
  }

  return { userId: sub, roles };
}

/** Convierte un JWK RSA de firma en clave pública; descarta lo que no sirva para RS256. */
function importJwk(jwk: Record<string, unknown>): KeyObject | undefined {
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return undefined;
  if (jwk.use !== undefined && jwk.use !== "sig") return undefined;
  if (jwk.alg !== undefined && jwk.alg !== "RS256") return undefined;
  try {
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey, format: "jwk" });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    return bits >= MIN_RSA_BITS ? key : undefined;
  } catch {
    return undefined;
  }
}

export interface JwksOptions {
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Intervalo mínimo entre recargas provocadas por un `kid` desconocido. */
  refreshCooldownMs?: number;
  timeoutMs?: number;
}

/**
 * Caché del JWKS de identity. Se carga la primera vez que hace falta y se recarga
 * cuando llega un `kid` desconocido (rotación de claves), como mucho una vez por
 * `refreshCooldownMs` para que tokens con `kid` inventados no inunden a identity.
 */
export function createJwksResolver(options: JwksOptions): KeyResolver {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cooldown = options.refreshCooldownMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 5_000;

  let keys: Map<string, KeyObject> | undefined;
  let lastFetch = -Infinity;
  let inflight: Promise<Map<string, KeyObject>> | undefined;

  async function load(): Promise<Map<string, KeyObject>> {
    let body: unknown;
    try {
      const response = await doFetch(options.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`http ${response.status}`);
      body = await response.json();
    } catch (error) {
      throw new JwksUnavailableError(`JWKS unavailable: ${String(error)}`);
    }
    const list = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(list)) throw new JwksUnavailableError("JWKS without keys");

    const loaded = new Map<string, KeyObject>();
    for (const jwk of list) {
      if (jwk === null || typeof jwk !== "object" || typeof jwk.kid !== "string") continue;
      const key = importJwk(jwk as Record<string, unknown>);
      if (key) loaded.set(jwk.kid, key);
    }
    return loaded;
  }

  function refresh(): Promise<Map<string, KeyObject>> {
    // Peticiones simultáneas comparten la misma descarga.
    inflight ??= load()
      .then((loaded) => {
        keys = loaded;
        return loaded;
      })
      .finally(() => {
        lastFetch = now();
        inflight = undefined;
      });
    return inflight;
  }

  return async (kid) => {
    const known = keys?.get(kid);
    if (known) return known;
    if (keys && now() - lastFetch < cooldown) return undefined;
    try {
      return (await refresh()).get(kid);
    } catch (error) {
      // Con una caché previa, un fallo de recarga no tumba los tokens ya conocidos:
      // el kid desconocido simplemente no es válido.
      if (keys) return undefined;
      throw error;
    }
  };
}
