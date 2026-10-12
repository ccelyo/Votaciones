// Recibo firmado (M4). Refleja ballot/internal/token/receipt.go:
// mensaje = dominio || uint16(len election) || election || ballotHash(32),
// firma Ed25519, sobre base64url(JSON {v, election_id, ballot_hash, signature}).

import { aBase64Url, deBase64Url, esIdentificadorValido } from "./token";

export const RECIBO_VERSION = 1;
const DOMINIO_RECIBO = "votaciones.ballot.receipt.v1\x00";

export interface Recibo {
  version: number;
  electionId: string;
  ballotHash: Uint8Array; // 32 bytes
  signature: Uint8Array; // 64 bytes
}

export function mensajeRecibo(electionId: string, ballotHash: Uint8Array): Uint8Array {
  if (!esIdentificadorValido(electionId, 128)) throw new Error("elección inválida");
  if (ballotHash.length !== 32) throw new Error("hash de papeleta inválido");
  const dominio = new TextEncoder().encode(DOMINIO_RECIBO);
  const eleccion = new TextEncoder().encode(electionId);
  const salida = new Uint8Array(dominio.length + 2 + eleccion.length + ballotHash.length);
  salida.set(dominio, 0);
  salida[dominio.length] = (eleccion.length >> 8) & 0xff;
  salida[dominio.length + 1] = eleccion.length & 0xff;
  salida.set(eleccion, dominio.length + 2);
  salida.set(ballotHash, dominio.length + 2 + eleccion.length);
  return salida;
}

export function serializarRecibo(recibo: Recibo): string {
  if (recibo.version !== RECIBO_VERSION || recibo.ballotHash.length !== 32 || recibo.signature.length !== 64) {
    throw new Error("recibo inválido");
  }
  const json = JSON.stringify({
    v: recibo.version,
    election_id: recibo.electionId,
    ballot_hash: aBase64Url(recibo.ballotHash),
    signature: aBase64Url(recibo.signature),
  });
  return aBase64Url(new TextEncoder().encode(json));
}

const CLAVES_RECIBO = ["v", "election_id", "ballot_hash", "signature"];

export function interpretarRecibo(sobre: string): Recibo {
  if (!sobre) throw new Error("recibo inválido");
  let crudo: Record<string, unknown>;
  try {
    const texto = new TextDecoder().decode(deBase64Url(sobre));
    crudo = JSON.parse(texto) as Record<string, unknown>;
  } catch {
    throw new Error("recibo inválido");
  }
  for (const k of Object.keys(crudo)) {
    if (CLAVES_RECIBO.indexOf(k) < 0) throw new Error("recibo inválido");
  }
  const recibo: Recibo = {
    version: crudo["v"] as number,
    electionId: crudo["election_id"] as string,
    ballotHash: deBase64Url(crudo["ballot_hash"] as string),
    signature: deBase64Url(crudo["signature"] as string),
  };
  if (recibo.version !== RECIBO_VERSION || recibo.ballotHash.length !== 32 || recibo.signature.length !== 64) {
    throw new Error("recibo inválido");
  }
  if (serializarRecibo(recibo) !== sobre) throw new Error("recibo inválido");
  return recibo;
}

export function hexDeBytes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verifica la firma Ed25519 del recibo con la clave pública en bruto (32 B). */
export async function verificarRecibo(clavePublica: Uint8Array, sobre: string): Promise<Recibo> {
  const recibo = interpretarRecibo(sobre);
  if (clavePublica.length !== 32) throw new Error("clave pública inválida");
  const clave = await crypto.subtle.importKey("raw", clavePublica.slice().buffer as ArrayBuffer, "Ed25519", false, [
    "verify",
  ]);
  const mensaje = mensajeRecibo(recibo.electionId, recibo.ballotHash);
  const valido = await crypto.subtle.verify(
    "Ed25519",
    clave,
    recibo.signature.slice().buffer as ArrayBuffer,
    mensaje.slice().buffer as ArrayBuffer,
  );
  if (!valido) throw new Error("firma del recibo inválida");
  return recibo;
}
