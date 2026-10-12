// Contratos HTTP que consume M4 (propuesta pendiente de M1/M6/M7).
// No se congelan aquí por decisión del equipo: M4 propone tipos + mocks
// y M1/M6/M7 los confirman. Ver 01-Prototype.md §15.

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
  votoCifradoB64: string;
  pruebaB64: string;
  tokenFirmado: string; // sobre base64url de lib/m4/token.ts
}

export interface RespuestaPapeleta {
  recibo: string; // sobre base64url de lib/m4/receipt.ts
  esReintento: boolean; // true si el servidor devolvió SpendReplay idéntico
}

export class ErrorPapeleta extends Error {
  codigo: "doble-voto" | "eleccion-cerrada" | "token-invalido" | "prueba-invalida" | "red";
  constructor(codigo: ErrorPapeleta["codigo"], mensaje: string) {
    super(mensaje);
    this.codigo = codigo;
  }
}

function aB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * GET /elections/{id}/parameters — CON sesión (la posee M3).
 * El navegador verifica la firma de parámetros antes de cifrar.
 */
export async function obtenerParametrosEleccion(electionId: string): Promise<ParametrosEleccion> {
  const respuesta = await fetch(`/api/elecciones/${encodeURIComponent(electionId)}/parametros`, {
    credentials: "include",
  });
  if (!respuesta.ok) throw new Error("no se pudieron cargar los parámetros de la elección");
  return (await respuesta.json()) as ParametrosEleccion;
}

/**
 * POST /ballots — SIN sesión, SIN cookies, SIN identificadores.
 * Restricción de anonimato (01-Prototype.md §9): credentials "omit" y
 * ninguna cabecera de identidad. M7 define el endpoint final; P1 usa mocks.
 */
export async function enviarPapeleta(solicitud: SolicitudPapeleta): Promise<RespuestaPapeleta> {
  const respuesta = await fetch("/api/papeletas", {
    method: "POST",
    credentials: "omit", // crítico: no vincular login con papeleta
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      election_id: solicitud.electionId,
      encrypted_vote: solicitud.votoCifradoB64,
      proof: solicitud.pruebaB64,
      signed_token: solicitud.tokenFirmado,
    }),
  });
  if (respuesta.status === 409) {
    throw new ErrorPapeleta("doble-voto", "Este token ya se usó con otra papeleta.");
  }
  if (respuesta.status === 410) {
    throw new ErrorPapeleta("eleccion-cerrada", "La elección ya está cerrada.");
  }
  if (respuesta.status === 401 || respuesta.status === 403) {
    throw new ErrorPapeleta("token-invalido", "El token anónimo no es válido.");
  }
  if (respuesta.status === 422) {
    throw new ErrorPapeleta("prueba-invalida", "La prueba de validez fue rechazada.");
  }
  if (!respuesta.ok) throw new ErrorPapeleta("red", "No se pudo enviar el voto. Intenta de nuevo.");
  const datos = (await respuesta.json()) as { receipt: string; replay?: boolean };
  return { recibo: datos.receipt, esReintento: datos.replay === true };
}

export { aB64 };
