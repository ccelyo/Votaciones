// Utilidades del sobre del token anónimo (M4).
// Refleja ballot/internal/token/token.go: dominio, canonización,
// sobre base64url JSON y TokenID = hex(SHA-256(sobre exacto)).
// La matemática ciega RSABSSA vive en blind.ts; aquí solo sobre.

export const TOKEN_VERSION = 1;
export const TOKEN_NONCE_SIZE = 32;
export const MAX_TOKEN_BYTES = 16 * 1024;

const TOKEN_DOMAIN = "votaciones.ballot.anonymous-token.v1\x00";

export interface SobreToken {
  version: number;
  kid: string;
  electionId: string;
  nonce: Uint8Array;
  preparedMessage: Uint8Array;
  signature: Uint8Array;
}

export function esIdentificadorValido(valor: string, maxBytes: number): boolean {
  const bytes = new TextEncoder().encode(valor);
  if (bytes.length === 0 || bytes.length > maxBytes) return false;
  if (valor.trim() !== valor) return false;
  for (const ch of valor) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x21 || cp === 0x7f || (cp <= 0x1f && cp !== 0x21)) return false;
    // Sin caracteres de control (Go: unicode.IsControl)
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  }
  return true;
}

/** Mensaje canónico que el navegador ciega y la identidad firma. */
export function mensajeCanonicoToken(electionId: string, nonce: Uint8Array): Uint8Array {
  if (!esIdentificadorValido(electionId, 128)) {
    throw new Error("identificador de elección inválido");
  }
  if (nonce.length !== TOKEN_NONCE_SIZE) {
    throw new Error("el nonce debe tener 32 bytes");
  }
  const dominio = new TextEncoder().encode(TOKEN_DOMAIN);
  const eleccion = new TextEncoder().encode(electionId);
  const salida = new Uint8Array(dominio.length + 2 + eleccion.length + nonce.length);
  salida.set(dominio, 0);
  salida[dominio.length] = (eleccion.length >> 8) & 0xff;
  salida[dominio.length + 1] = eleccion.length & 0xff;
  salida.set(eleccion, dominio.length + 2);
  salida.set(nonce, dominio.length + 2 + eleccion.length);
  return salida;
}

export function generarNonce(): Uint8Array {
  const nonce = new Uint8Array(TOKEN_NONCE_SIZE);
  crypto.getRandomValues(nonce);
  return nonce;
}

// ---- base64url sin padding (compatible navegador + Node) ----

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function aBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

export function deBase64Url(texto: string): Uint8Array {
  if (!texto) throw new Error("token inválido");
  for (const c of texto) {
    if (B64URL.indexOf(c) < 0) throw new Error("token inválido");
  }
  let b64 = texto.replace(/-/g, "+").replace(/_/g, "/");
  const resto = b64.length % 4;
  if (resto === 1) throw new Error("token inválido");
  if (resto !== 0) b64 += "=".repeat(4 - resto);
  const bin = atob(b64);
  const salida = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) salida[i] = bin.charCodeAt(i);
  return salida;
}

function validarSobre(token: SobreToken): void {
  if (
    token.version !== TOKEN_VERSION ||
    !esIdentificadorValido(token.kid, 64) ||
    !esIdentificadorValido(token.electionId, 128) ||
    token.nonce.length !== TOKEN_NONCE_SIZE ||
    token.preparedMessage.length < 32 + TOKEN_DOMAIN.length ||
    token.preparedMessage.length > 1024 ||
    token.signature.length < 256 ||
    token.signature.length > 1024
  ) {
    throw new Error("token inválido");
  }
}

/** Serializa el sobre a base64url(JSON compacto), como MarshalSignedToken en Go. */
export function serializarSobre(token: SobreToken): string {
  validarSobre(token);
  const json = JSON.stringify({
    v: token.version,
    kid: token.kid,
    election_id: token.electionId,
    nonce: aBase64Url(token.nonce),
    prepared_message: aBase64Url(token.preparedMessage),
    signature: aBase64Url(token.signature),
  });
  const bytes = new TextEncoder().encode(json);
  const sobre = aBase64Url(bytes);
  if (sobre.length > MAX_TOKEN_BYTES) throw new Error("token inválido");
  return sobre;
}

interface SobreWire {
  v: number;
  kid: string;
  election_id: string;
  nonce: string;
  prepared_message: string;
  signature: string;
}

const CLAVES_PERMITIDAS = ["v", "kid", "election_id", "nonce", "prepared_message", "signature"];

/** Parseo estricto: rechaza campos desconocidos y exige recodificación canónica idéntica. */
export function interpretarSobre(sobre: string): SobreToken {
  if (!sobre || sobre.length > MAX_TOKEN_BYTES) throw new Error("token inválido");
  let wire: SobreWire;
  try {
    const jsonBytes = deBase64Url(sobre);
    const texto = new TextDecoder().decode(jsonBytes);
    const crudo: unknown = JSON.parse(texto);
    if (typeof crudo !== "object" || crudo === null) throw new Error("token inválido");
    for (const k of Object.keys(crudo as Record<string, unknown>)) {
      if (CLAVES_PERMITIDAS.indexOf(k) < 0) throw new Error("token inválido");
    }
    wire = crudo as SobreWire;
  } catch {
    throw new Error("token inválido");
  }
  const token: SobreToken = {
    version: wire.v,
    kid: wire.kid,
    electionId: wire.election_id,
    nonce: deBase64Url(wire.nonce),
    preparedMessage: deBase64Url(wire.prepared_message),
    signature: deBase64Url(wire.signature),
  };
  validarSobre(token);
  if (serializarSobre(token) !== sobre) throw new Error("token inválido");
  return token;
}

/** TokenID = hex(SHA-256(sobre exacto)). Es el _id en Mongo según Go. */
export async function tokenIdHex(sobre: string): Promise<string> {
  const bytes = new TextEncoder().encode(sobre);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
