// Validación de JWT HS256 (actividad CR-04). Contrato acordado con Auth en README.md.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtOptions {
  secret: string;
  issuer?: string;
  audience?: string;
  clockToleranceSeconds?: number;
  now?: () => number;
}

export interface Principal {
  userId: string;
  roles: string[];
}

export class JwtError extends Error {}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new JwtError("malformed token");
  }
}

export function verifyJwt(token: string, options: JwtOptions): Principal {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeSegment(headerSegment) as { alg?: unknown; typ?: unknown };
  // Solo HS256: rechaza "none" y cualquier otro algoritmo.
  if (header.alg !== "HS256") throw new JwtError("unsupported algorithm");

  const expected = createHmac("sha256", options.secret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  const actual = Buffer.from(signatureSegment, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError("invalid signature");
  }

  const claims = decodeSegment(payloadSegment) as Record<string, unknown>;
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const tolerance = options.clockToleranceSeconds ?? 30;

  if (typeof claims.exp !== "number") throw new JwtError("missing exp");
  if (now > claims.exp + tolerance) throw new JwtError("token expired");
  if (typeof claims.nbf === "number" && now + tolerance < claims.nbf) {
    throw new JwtError("token not yet valid");
  }
  if (options.issuer && claims.iss !== options.issuer) throw new JwtError("invalid issuer");
  if (options.audience) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(options.audience)) throw new JwtError("invalid audience");
  }

  const sub = claims.sub;
  if ((typeof sub !== "string" && typeof sub !== "number") || String(sub) === "") {
    throw new JwtError("missing sub");
  }

  let roles: string[] = [];
  if (Array.isArray(claims.roles)) {
    roles = claims.roles.filter((r): r is string => typeof r === "string");
  } else if (typeof claims.role === "string") {
    roles = [claims.role];
  }

  return { userId: String(sub), roles };
}

/** Firma un JWT HS256. Solo para pruebas y desarrollo local. */
export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
