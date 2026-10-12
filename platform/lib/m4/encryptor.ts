// Cifrado del voto (M4). P1 usa stub detrás de una interfaz.
// Ver platform/M4_REMINDER.md: Go solo acepta bytes opacos + prueba stub.
// El cifrado real (ElGamal + prueba OR) reemplazará StubEncryptor sin tocar la UI.

export interface VotoCifrado {
  ciphertext: Uint8Array;
  proof: Uint8Array;
}

export interface Cifrador {
  cifrar(opcion: string, electionId: string): Promise<VotoCifrado>;
}

const TEXTO_VOTO_SIMULADO = "stub-encrypted-vote";
const TEXTO_PRUEBA_SIMULADA = "stub-benaloh-proof";

/** Stub compatible con ballot/internal/server/happy_path_test.go. */
export class CifradorSimulado implements Cifrador {
  async cifrar(opcion: string, _electionId: string): Promise<VotoCifrado> {
    if (!opcion || opcion.trim() !== opcion) throw new Error("opción inválida");
    // El contenido real no depende de la opción en P1 a propósito (stub).
    // P2: cifrar aquí la opción con la clave pública de la elección.
    const codificador = new TextEncoder();
    return {
      ciphertext: codificador.encode(TEXTO_VOTO_SIMULADO),
      proof: codificador.encode(TEXTO_PRUEBA_SIMULADA),
    };
  }
}

// TODO(P2): CifradorElGamal con @noble/curves + prueba Chaum-Pedersen OR.
// Debe respetar maxEncryptedBytes=1MiB y maxProofBytes=256KiB de
// ballot/internal/ballot/hash.go y acordar Verify() con M7.
