// Cliente de firma ciega RSABSSA-SHA384-PSS-Randomized (M4, Prototype 1).
//
// `cegar`/`descegar` operan sobre el entero en crudo (usados por los tests).
// El flujo real usa `cegarPss`/`finalizarPss` (al final del archivo), que
// aplican EMSA-PSS con SHA-384 como RFC 9474 y verifican la firma final con
// WebCrypto antes de construir el token que valida circl/blindrsa en Go.
//
// NO usa dependencias nuevas: solo BigInt + WebCrypto.

import { generarNonce, mensajeCanonicoToken } from "./token";

export const VARIANTE_PROPUESTA = "RSABSSA-SHA384-PSS-Randomized";
export const PREFIJO_ALEATORIO_SIZE = 32;

export interface EstadoCegado {
  r: bigint;
  rInverso: bigint;
  n: bigint;
  prepared: Uint8Array;
}

/** Convierte bytes big-endian a entero. */
export function os2ip(bytes: Uint8Array): bigint {
  let valor = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    valor = (valor << BigInt(8)) + BigInt(bytes[i]);
  }
  return valor;
}

/** Convierte entero a bytes big-endian de longitud fija. */
export function i2osp(valor: bigint, longitud: number): Uint8Array {
  if (valor < BigInt(0)) throw new Error("entero negativo");
  const salida = new Uint8Array(longitud);
  let resto = valor;
  for (let i = longitud - 1; i >= 0; i--) {
    salida[i] = Number(resto & BigInt(0xff));
    resto = resto >> BigInt(8);
  }
  if (resto !== BigInt(0)) throw new Error("entero demasiado grande");
  return salida;
}

export function mcd(a: bigint, b: bigint): bigint {
  let x = a < BigInt(0) ? -a : a;
  let y = b < BigInt(0) ? -b : b;
  while (y !== BigInt(0)) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function inversoModular(a: bigint, n: bigint): bigint {
  let [viejoR, r] = [a, n];
  let [viejoS, s] = [BigInt(1), BigInt(0)];
  while (r !== BigInt(0)) {
    const cociente = viejoR / r;
    const tmpR = viejoR;
    viejoR = r;
    r = tmpR - cociente * r;
    const tmpS = viejoS;
    viejoS = s;
    s = tmpS - cociente * s;
  }
  if (viejoR !== BigInt(1) && viejoR !== BigInt(-1)) {
    throw new Error("sin inverso modular (r no coprimo con n)");
  }
  const resultado = viejoS % n;
  return resultado < BigInt(0) ? resultado + n : resultado;
}

export function potenciaModular(base: bigint, exponente: bigint, modulo: bigint): bigint {
  if (modulo === BigInt(1)) return BigInt(0);
  let resultado = BigInt(1);
  let b = ((base % modulo) + modulo) % modulo;
  let e = exponente;
  while (e > BigInt(0)) {
    if (e & BigInt(1)) resultado = (resultado * b) % modulo;
    b = (b * b) % modulo;
    e = e >> BigInt(1);
  }
  return resultado;
}

function longitudModulo(n: bigint): number {
  let bits = 0;
  let t = n;
  while (t > BigInt(0)) {
    t = t >> BigInt(1);
    bits++;
  }
  return Math.ceil(bits / 8);
}

function enteroAleatorioMenorQue(n: bigint): bigint {
  const k = longitudModulo(n);
  for (let intento = 0; intento < 50; intento++) {
    const buf = new Uint8Array(k);
    crypto.getRandomValues(buf);
    const candidato = os2ip(buf) % n;
    if (candidato > BigInt(1) && candidato < n - BigInt(1) && mcd(candidato, n) === BigInt(1)) {
      return candidato;
    }
  }
  throw new Error("no se pudo generar factor de cegado");
}

/** Prepare(rand, mensaje): prefijo aleatorio de 32 B + mensaje canónico. */
export function preparar(nonce: Uint8Array, electionId: string): { prepared: Uint8Array; nonce: Uint8Array } {
  const mensaje = mensajeCanonicoToken(electionId, nonce);
  const prefijo = new Uint8Array(PREFIJO_ALEATORIO_SIZE);
  crypto.getRandomValues(prefijo);
  const prepared = new Uint8Array(prefijo.length + mensaje.length);
  prepared.set(prefijo, 0);
  prepared.set(mensaje, prefijo.length);
  return { prepared, nonce };
}

/** Genera nonce + prepared en un paso (lo que hace el navegador). */
export function prepararToken(electionId: string): { prepared: Uint8Array; nonce: Uint8Array } {
  return preparar(generarNonce(), electionId);
}

export interface ClavePublicaRSA {
  n: bigint;
  e: bigint;
}

/** Extrae (n, e) de una clave pública SPKI DER (SubjectPublicKeyInfo RSA). */
export function claveDesdeDerSpki(der: Uint8Array): ClavePublicaRSA {
  // ASN.1 mínimo: SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }
  let pos = 0;
  function leerLongitud(): number {
    const primero = der[pos++];
    if (primero < 0x80) return primero;
    const nBytes = primero & 0x7f;
    if (nBytes === 0 || nBytes > 4) throw new Error("DER inválido");
    let len = 0;
    for (let i = 0; i < nBytes; i++) len = (len << 8) | der[pos++];
    return len;
  }
  function esperar(etiqueta: number): void {
    if (der[pos++] !== etiqueta) throw new Error("DER inválido");
  }
  function leerEntero(): bigint {
    esperar(0x02);
    const len = leerLongitud();
    const bytes = der.slice(pos, pos + len);
    pos += len;
    let inicio = 0;
    if (bytes.length > 1 && bytes[0] === 0x00) inicio = 1; // quita cero de signo
    return os2ip(bytes.slice(inicio));
  }
  esperar(0x30);
  leerLongitud();
  esperar(0x30);
  const lenAlg = leerLongitud();
  pos += lenAlg; // salta OID rsaEncryption + NULL (ya validado por longitud)
  esperar(0x03);
  const lenBit = leerLongitud();
  const finBit = pos + lenBit;
  if (der[pos++] !== 0x00) throw new Error("DER inválido"); // unused bits
  esperar(0x30);
  leerLongitud();
  const n = leerEntero();
  const eNum = leerEntero();
  if (pos > finBit) throw new Error("DER inválido");
  if (n < BigInt(1) << BigInt(2047)) throw new Error("clave RSA menor a 2048 bits");
  return { n, e: eNum };
}

/** Blind(prepared): cegado = prepared * r^e mod n. */
export function cegar(prepared: Uint8Array, clave: ClavePublicaRSA): { cegado: Uint8Array; estado: EstadoCegado } {
  const k = longitudModulo(clave.n);
  const m = os2ip(prepared);
  if (m <= BigInt(0) || m >= clave.n) throw new Error("mensaje fuera de rango para la clave");
  const r = enteroAleatorioMenorQue(clave.n);
  const rE = potenciaModular(r, clave.e, clave.n);
  const cegadoEntero = (m * rE) % clave.n;
  return { cegado: i2osp(cegadoEntero, k), estado: { r, rInverso: inversoModular(r, clave.n), n: clave.n, prepared } };
}

/** Finalize: десcegado s = firmaCegada * r^-1 mod n. */
export function descegar(firmaCegada: Uint8Array, estado: EstadoCegado): Uint8Array {
  const k = longitudModulo(estado.n);
  if (firmaCegada.length !== k) throw new Error("firma cegada con longitud incorrecta");
  const sCiego = os2ip(firmaCegada);
  const s = (sCiego * estado.rInverso) % estado.n;
  return i2osp(s, k);
}

// ---- RFC 9474 completo: EMSA-PSS (SHA-384) + verificación WebCrypto ----

const HASH_LEN = 48; // SHA-384

/** Longitud de sal según la variante RSABSSA-SHA384 (PSS = 48, PSSZERO = 0). */
export function longitudSal(variante: string): number {
  if (variante === "RSABSSA-SHA384-PSS-Randomized") return HASH_LEN;
  if (variante === "RSABSSA-SHA384-PSSZERO-Randomized") return 0;
  throw new Error(`variante de firma ciega no soportada: ${variante}`);
}

function bitsModulo(n: bigint): number {
  return n.toString(2).length;
}

async function sha384(datos: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-384", datos.slice().buffer as ArrayBuffer));
}

async function mgf1(semilla: Uint8Array, longitud: number): Promise<Uint8Array> {
  const salida = new Uint8Array(longitud);
  let pos = 0;
  for (let contador = 0; pos < longitud; contador++) {
    const entrada = new Uint8Array(semilla.length + 4);
    entrada.set(semilla, 0);
    entrada.set(i2osp(BigInt(contador), 4), semilla.length);
    const bloque = await sha384(entrada);
    const n = Math.min(bloque.length, longitud - pos);
    salida.set(bloque.subarray(0, n), pos);
    pos += n;
  }
  return salida;
}

/** EMSA-PSS-ENCODE (RFC 8017 §9.1.1) con SHA-384 y MGF1-SHA-384. */
export async function codificarPss(mensaje: Uint8Array, emBits: number, sLen: number): Promise<Uint8Array> {
  const emLen = Math.ceil(emBits / 8);
  if (emLen < HASH_LEN + sLen + 2) throw new Error("clave demasiado pequeña para PSS");
  const mHash = await sha384(mensaje);
  const sal = new Uint8Array(sLen);
  crypto.getRandomValues(sal);
  const mPrima = new Uint8Array(8 + HASH_LEN + sLen);
  mPrima.set(mHash, 8);
  mPrima.set(sal, 8 + HASH_LEN);
  const h = await sha384(mPrima);
  const db = new Uint8Array(emLen - HASH_LEN - 1);
  db[db.length - sLen - 1] = 0x01;
  db.set(sal, db.length - sLen);
  const mascara = await mgf1(h, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= mascara[i];
  db[0] &= 0xff >> (8 * emLen - emBits);
  const em = new Uint8Array(emLen);
  em.set(db, 0);
  em.set(h, db.length);
  em[emLen - 1] = 0xbc;
  return em;
}

/** RFC 9474 §4.1 Blind: cegado = EMSA-PSS(prepared) * r^e mod n. */
export async function cegarPss(
  prepared: Uint8Array,
  clave: ClavePublicaRSA,
  variante: string,
): Promise<{ cegado: Uint8Array; estado: EstadoCegado }> {
  const codificado = await codificarPss(prepared, bitsModulo(clave.n) - 1, longitudSal(variante));
  const m = os2ip(codificado);
  if (mcd(m, clave.n) !== BigInt(1)) throw new Error("mensaje codificado inválido para la clave");
  const r = enteroAleatorioMenorQue(clave.n);
  const cegadoEntero = (m * potenciaModular(r, clave.e, clave.n)) % clave.n;
  return {
    cegado: i2osp(cegadoEntero, longitudModulo(clave.n)),
    estado: { r, rInverso: inversoModular(r, clave.n), n: clave.n, prepared },
  };
}

/** RFC 9474 §4.3 Finalize: descega y verifica RSASSA-PSS con WebCrypto. */
export async function finalizarPss(
  firmaCegada: Uint8Array,
  estado: EstadoCegado,
  claveDer: Uint8Array,
  variante: string,
): Promise<Uint8Array> {
  const firma = descegar(firmaCegada, estado);
  const clave = await crypto.subtle.importKey(
    "spki",
    claveDer.slice().buffer as ArrayBuffer,
    { name: "RSA-PSS", hash: "SHA-384" },
    false,
    ["verify"],
  );
  const valida = await crypto.subtle.verify(
    { name: "RSA-PSS", saltLength: longitudSal(variante) },
    clave,
    firma.slice().buffer as ArrayBuffer,
    estado.prepared.slice().buffer as ArrayBuffer,
  );
  if (!valida) throw new Error("la firma ciega devuelta por identidad no es válida");
  return firma;
}
