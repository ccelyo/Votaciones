import 'dart:convert';
import 'dart:typed_data';

const b64Url =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

String aBase64Url(Uint8List bytes) {
  return base64Url.encode(bytes).replaceAll('=', '');
}

Uint8List deBase64Url(String texto) {
  if (texto.isEmpty) {
    throw const FormatException('token inválido');
  }
  for (final unidad in texto.codeUnits) {
    final caracter = String.fromCharCode(unidad);
    if (!b64Url.contains(caracter)) {
      throw const FormatException('token inválido');
    }
  }
  var normalizado = texto;
  final resto = normalizado.length % 4;
  if (resto == 1) {
    throw const FormatException('token inválido');
  }
  if (resto != 0) {
    normalizado = normalizado.padRight(normalizado.length + (4 - resto), '=');
  }
  return Uint8List.fromList(base64Url.decode(normalizado));
}

BigInt os2ip(Uint8List bytes) {
  var valor = BigInt.zero;
  for (final byte in bytes) {
    valor = (valor << 8) + BigInt.from(byte);
  }
  return valor;
}

Uint8List i2osp(BigInt valor, int longitud) {
  if (valor.isNegative) {
    throw StateError('entero negativo');
  }
  final salida = Uint8List(longitud);
  var resto = valor;
  final mascara = BigInt.from(0xff);
  for (var i = longitud - 1; i >= 0; i--) {
    salida[i] = (resto & mascara).toInt();
    resto = resto >> 8;
  }
  if (resto != BigInt.zero) {
    throw StateError('entero demasiado grande');
  }
  return salida;
}

int longitudModulo(BigInt n) => (n.bitLength + 7) >> 3;
