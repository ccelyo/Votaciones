// Cliente de firma ciega RSABSSA-SHA384-PSS-Randomized (M4, Prototype 1).
//
// Alcance honesto P1: implementa el armazón puro-TS (Prepare/Blind/Finalize)
// con aritmética BigInt y factor de cegado r^e. La codificación EMSA-PSS
// exacta de circl/blindrsa y los vectores de interop con Go quedan pendientes
// de acuerdo M6 (ver proto/README.md). Por eso el firmante simulado de P1
// firma el entero cegado en crudo; el verificador simulado verifica en crudo.
// La interfaz ya aísla ese detalle: cuando M6 fije la variante, solo cambia
// el codificador PSS inyectado, no la UI ni el flujo.
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
