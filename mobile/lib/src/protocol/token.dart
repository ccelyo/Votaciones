import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'codec.dart';

const tokenVersion = 1;
const tokenNonceSize = 32;
const maxTokenBytes = 16 * 1024;
const tokenDomain = 'votaciones.ballot.anonymous-token.v1\x00';

class SobreToken {
  const SobreToken({
    required this.version,
    required this.kid,
    required this.electionId,
    required this.nonce,
    required this.preparedMessage,
    required this.signature,
  });

  final int version;
  final String kid;
  final String electionId;
  final Uint8List nonce;
  final Uint8List preparedMessage;
  final Uint8List signature;
}

bool esIdentificadorValido(String valor, int maxBytes) {
  final bytes = utf8.encode(valor);
  if (bytes.isEmpty || bytes.length > maxBytes || valor.trim() != valor) {
    return false;
  }
  for (final cp in valor.runes) {
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      return false;
    }
  }
  return true;
}

/// Mensaje canónico que el teléfono ciega y la identidad firma.
Uint8List mensajeCanonicoToken(String electionId, Uint8List nonce) {
  if (!esIdentificadorValido(electionId, 128)) {
    throw StateError('identificador de elección inválido');
  }
  if (nonce.length != tokenNonceSize) {
    throw StateError('el nonce debe tener 32 bytes');
  }
  final dominio = utf8.encode(tokenDomain);
  final eleccion = utf8.encode(electionId);
  final salida = Uint8List(dominio.length + 2 + eleccion.length + nonce.length);
  salida.setRange(0, dominio.length, dominio);
  salida[dominio.length] = (eleccion.length >> 8) & 0xff;
  salida[dominio.length + 1] = eleccion.length & 0xff;
  salida.setRange(
      dominio.length + 2, dominio.length + 2 + eleccion.length, eleccion);
  salida.setRange(dominio.length + 2 + eleccion.length, salida.length, nonce);
  return salida;
}

Uint8List generarNonce() {
  final random = Random.secure();
  return Uint8List.fromList(
      List.generate(tokenNonceSize, (_) => random.nextInt(256)));
}

String serializarSobre(SobreToken token) {
  if (token.version != tokenVersion ||
      !esIdentificadorValido(token.kid, 64) ||
      !esIdentificadorValido(token.electionId, 128) ||
      token.nonce.length != tokenNonceSize ||
      token.preparedMessage.length < 32 + utf8.encode(tokenDomain).length ||
      token.preparedMessage.length > 1024 ||
      token.signature.length < 256 ||
      token.signature.length > 1024) {
    throw StateError('token inválido');
  }
  final json = '{"v":${token.version},'
      '"kid":${jsonEncode(token.kid)},'
      '"election_id":${jsonEncode(token.electionId)},'
      '"nonce":"${aBase64Url(token.nonce)}",'
      '"prepared_message":"${aBase64Url(token.preparedMessage)}",'
      '"signature":"${aBase64Url(token.signature)}"}';
  final sobre = aBase64Url(Uint8List.fromList(utf8.encode(json)));
  if (sobre.length > maxTokenBytes) {
    throw StateError('token inválido');
  }
  return sobre;
}
