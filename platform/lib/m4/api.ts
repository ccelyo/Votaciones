// Cliente HTTP del servicio `ballot` (M4). Contrato: ballot/internal/httpapi/server.go.
// Los parámetros de la elección y la firma ciega los sirve identidad (lib/api.ts).

import { aBase64Url } from "./token";

const BALLOT_API_URL = (process.env.NEXT_PUBLIC_BALLOT_API_URL ?? "").replace(/\/+$/, "");

export interface ParametrosEleccion {
  electionId: string;
  opciones: string[];
  claveCifradoB64: string; // clave pública de cifrado, opaca en P1
  parametrosFirmadosB64: string; // bytes canónicos firmados por identidad
  firmaParametrosB64: string;
  algoritmoFirma: string;
  kidFirma: string;
}

export interface SolicitudPapeleta {
  electionId: string;
  votoCifrado: Uint8Array;
  prueba: Uint8Array;
  tokenFirmado: string; // sobre base64url de lib/m4/token.ts
}

export interface RespuestaPapeleta {
  recibo: string; // sobre base64url de lib/m4/receipt.ts
  hashPapeleta: string; // base64url
  esReintento: boolean; // true si el servidor devolvió SpendReplay idéntico
}

export class ErrorPapeleta extends Error {
  codigo: "doble-voto" | "eleccion-cerrada" | "token-invalido" | "prueba-invalida" | "red";
  constructor(codigo: ErrorPapeleta["codigo"], mensaje: string) {
    super(mensaje);
    this.codigo = codigo;
  }
}

/**
 * POST /v1/ballots — SIN sesión, SIN cookies, SIN identificadores.
 * Restricción de anonimato (01-Prototype.md §9): credentials "omit" y
 * ninguna cabecera de identidad.
 */
export async function enviarPapeleta(solicitud: SolicitudPapeleta): Promise<RespuestaPapeleta> {
  if (!BALLOT_API_URL) {
    throw new ErrorPapeleta("red", "Configura NEXT_PUBLIC_BALLOT_API_URL para enviar votos.");
  }
  let respuesta: Response;
  try {
    respuesta = await fetch(`${BALLOT_API_URL}/v1/ballots`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit", // crítico: no vincular login con papeleta
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        election_id: solicitud.electionId,
        token: solicitud.tokenFirmado,
        encrypted_vote: aBase64Url(solicitud.votoCifrado),
        proof: aBase64Url(solicitud.prueba),
      }),
    });
  } catch {
    throw new ErrorPapeleta("red", "No se pudo contactar el servicio de votación. Intenta de nuevo.");
  }
  if (!respuesta.ok) {
    const cuerpo = (await respuesta.json().catch(() => null)) as { error?: string } | null;
    switch (cuerpo?.error) {
      case "token_already_spent":
        throw new ErrorPapeleta("doble-voto", "Este token ya se usó con otra papeleta.");
      case "election_not_open":
        throw new ErrorPapeleta("eleccion-cerrada", "La elección no está abierta.");
      case "invalid_token":
      case "invalid_token_signature":
      case "token_election_mismatch":
        throw new ErrorPapeleta("token-invalido", "El token anónimo no es válido.");
      case "invalid_proof":
        throw new ErrorPapeleta("prueba-invalida", "La prueba de validez fue rechazada.");
      default:
        throw new ErrorPapeleta("red", `No se pudo enviar el voto (${respuesta.status}). Intenta de nuevo.`);
    }
  }
  const datos = (await respuesta.json()) as { receipt: string; ballot_hash: string; replayed: boolean };
  return { recibo: datos.receipt, hashPapeleta: datos.ballot_hash, esReintento: datos.replayed === true };
}

export interface ResultadoOpcion {
  opcion: string;
  votos: number;
}

export interface ResultadosEleccion {
  totalPapeletas: number;
  papeletasInvalidas: number;
  resultados: ResultadoOpcion[];
}

/**
 * GET /v1/elections/{id}/results — conteo agregado, solo con la urna cerrada.
 * Devuelve null si la elección sigue abierta. Tampoco lleva credenciales.
 */
export async function obtenerResultados(electionId: string): Promise<ResultadosEleccion | null> {
  if (!BALLOT_API_URL) {
    throw new Error("Configura NEXT_PUBLIC_BALLOT_API_URL para consultar los resultados.");
  }
  let respuesta: Response;
  try {
    respuesta = await fetch(`${BALLOT_API_URL}/v1/elections/${encodeURIComponent(electionId)}/results`, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new Error("No se pudo contactar el servicio de votación.");
  }
  if (respuesta.status === 409) return null;
  if (!respuesta.ok) {
    throw new Error(`No se pudieron cargar los resultados (${respuesta.status}).`);
  }
  const datos = (await respuesta.json()) as {
    total_ballots: number;
    invalid_ballots: number;
    results: { option: string; votes: number }[];
  };
  return {
    totalPapeletas: datos.total_ballots,
    papeletasInvalidas: datos.invalid_ballots,
    resultados: datos.results.map((r) => ({ opcion: r.option, votos: r.votes })),
  };
}
