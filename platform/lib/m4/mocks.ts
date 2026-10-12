// Mocks de P1 para trabajar sin bloquearse con M1/M6/M7.
// Elección demo + firmante/recibo simulados con WebCrypto real (Ed25519).

import type { ParametrosEleccion } from "./api";
import { serializarRecibo } from "./receipt";

export const ELECCION_DEMO_ID = "eleccion-demo";

export function parametrosDemo(): ParametrosEleccion {
  return {
    electionId: ELECCION_DEMO_ID,
    opciones: ["Opción A", "Opción B", "Voto en blanco"],
    claveCifradoB64: btoa("clave-cifrado-simulada-p1"),
    parametrosFirmadosB64: btoa("parametros-simulados-p1"),
    firmaParametrosB64: btoa("firma-simulada-p1"),
    algoritmoFirma: "pendiente-acuerdo-M1",
    kidFirma: "demo-kid-1",
  };
}

function hashSimulado(electionId: string, texto: string): Promise<Uint8Array> {
  const datos = new TextEncoder().encode(electionId + "|" + texto);
  return crypto.subtle.digest("SHA-256", datos).then((d) => new Uint8Array(d));
}

export interface ParClavesRecibo {
  publica: Uint8Array;
  privada: CryptoKey;
}

const clavesPorEleccion = new Map<string, ParClavesRecibo>();

export async function clavesReciboDemo(electionId: string): Promise<ParClavesRecibo> {
  const existente = clavesPorEleccion.get(electionId);
  if (existente) return existente;
  const par = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const publica = new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey));
  const registro = { publica, privada: par.privateKey };
  clavesPorEleccion.set(electionId, registro);
  return registro;
}

/** Recibo simulado válido: hash SHA-256 + firma Ed25519 real. */
export async function reciboDemo(electionId: string, textoVoto: string): Promise<string> {
  const { privada } = await clavesReciboDemo(electionId);
  const hash = await hashSimulado(electionId, textoVoto);
  const dominio = new TextEncoder().encode("votaciones.ballot.receipt.v1\x00");
  const eleccion = new TextEncoder().encode(electionId);
  const mensaje = new Uint8Array(dominio.length + 2 + eleccion.length + hash.length);
  mensaje.set(dominio, 0);
  mensaje[dominio.length] = (eleccion.length >> 8) & 0xff;
  mensaje[dominio.length + 1] = eleccion.length & 0xff;
  mensaje.set(eleccion, dominio.length + 2);
  mensaje.set(hash, dominio.length + 2 + eleccion.length);
  const firma = new Uint8Array(await crypto.subtle.sign("Ed25519", privada, mensaje.slice().buffer as ArrayBuffer));
  return serializarRecibo({ version: 1, electionId, ballotHash: hash, signature: firma });
}
