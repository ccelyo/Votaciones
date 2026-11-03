// Utilidades de prueba: emiten JWT RS256 como identity. El Gateway no firma tokens.

import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function newKey(kid: string, modulusLength = 2048): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength });
  return { kid, privateKey, publicKey };
}

export function jwks(...keys: TestKey[]): { keys: Record<string, unknown>[] } {
  return {
    keys: keys.map((key) => ({
      ...key.publicKey.export({ format: "jwk" }),
      kid: key.kid,
      use: "sig",
      alg: "RS256",
    })),
  };
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signRs256(
  claims: Record<string, unknown>,
  key: TestKey,
  header: Record<string, unknown> = {},
): string {
  const signingInput = `${segment({ alg: "RS256", typ: "JWT", kid: key.kid, ...header })}.${segment(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput), key.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Ataque de confusión de algoritmo: HS256 usando la clave pública como secreto. */
export function signHs256WithPublicKey(claims: Record<string, unknown>, key: TestKey): string {
  const signingInput = `${segment({ alg: "HS256", typ: "JWT", kid: key.kid })}.${segment(claims)}`;
  const secret = key.publicKey.export({ format: "pem", type: "spki" });
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export const ISSUER = "votaciones-identity";
export const AUDIENCE = "votaciones";

export function identityClaims(overrides: Record<string, unknown> = {}, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "42",
    username: "votante",
    role: "voter",
    iat: now,
    nbf: now,
    exp: now + 3600,
    jti: "jti-de-prueba",
    ...overrides,
  };
}
