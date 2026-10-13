// "Cifrado" del voto (M4). P1 guarda la opción en texto plano detrás de una
// interfaz para poder contar los votos; el cifrado real (ElGamal + prueba OR)
// reemplazará CifradorTextoPlano sin tocar la UI.
// La papeleta sigue siendo anónima: entra con un token ciego y nunca lleva
// datos del votante, así que el texto plano no revela quién votó.

export interface VotoCifrado {
  ciphertext: Uint8Array;
  proof: Uint8Array;
}

export interface Cifrador {
  cifrar(opcion: string, electionId: string): Promise<VotoCifrado>;
}

const TEXTO_PRUEBA_SIMULADA = "stub-benaloh-proof";

/**
 * P1: el "ciphertext" es la opción en UTF-8, tal cual la cuenta
 * ballot/internal/ballot/tally.go. La prueba sigue siendo un stub.
 */
export class CifradorTextoPlano implements Cifrador {
  async cifrar(opcion: string, _electionId: string): Promise<VotoCifrado> {
    if (!opcion || opcion.trim() !== opcion) throw new Error("opción inválida");
    const codificador = new TextEncoder();
    return {
      ciphertext: codificador.encode(opcion),
      proof: codificador.encode(TEXTO_PRUEBA_SIMULADA),
    };
  }
}

// TODO(P2): CifradorElGamal con @noble/curves + prueba Chaum-Pedersen OR.
// Debe respetar maxEncryptedBytes=1MiB y maxProofBytes=256KiB de
// ballot/internal/ballot/hash.go, acordar Verify() con M7 y sustituir el
// conteo en claro por el descifrado homomórfico del total.
