import 'dart:convert';
import 'dart:typed_data';

const pruebaSimulada = 'stub-benaloh-proof';

class VotoCifrado {
  const VotoCifrado({required this.ciphertext, required this.proof});

  final Uint8List ciphertext;
  final Uint8List proof;
}

/// El prototipo guarda la opción en UTF-8. El cifrado real la reemplaza aquí.
VotoCifrado cifrarOpcion(String opcion) {
  if (opcion.isEmpty || opcion.trim() != opcion) {
    throw StateError('opción inválida');
  }
  return VotoCifrado(
    ciphertext: Uint8List.fromList(utf8.encode(opcion)),
    proof: Uint8List.fromList(utf8.encode(pruebaSimulada)),
  );
}
