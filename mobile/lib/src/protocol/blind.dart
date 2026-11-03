import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'codec.dart';
import 'token.dart';

const variantePropuesta = 'RSABSSA-SHA384-PSS-Randomized';
const prefijoAleatorioSize = 32;
const _hashLen = 48;

class ClavePublicaRsa {
  const ClavePublicaRsa({required this.n, required this.e});

  final BigInt n;
  final BigInt e;
}

class EstadoCegado {
  const EstadoCegado(
      {required this.r,
      required this.rInverso,
      required this.n,
      required this.prepared});

  final BigInt r;
  final BigInt rInverso;
  final BigInt n;
  final Uint8List prepared;
}

/// Extrae (n, e) de una clave pública SPKI DER.
ClavePublicaRsa claveDesdeDerSpki(Uint8List der) {
  var pos = 0;
  int leerLongitud() {
    final primero = der[pos++];
    if (primero < 0x80) return primero;
    final nBytes = primero & 0x7f;
    if (nBytes == 0 || nBytes > 4) {
      throw const FormatException('DER inválido');
    }
    var len = 0;
    for (var i = 0; i < nBytes; i++) {
      len = (len << 8) | der[pos++];
    }
    return len;
  }

  void esperar(int etiqueta) {
    if (der[pos++] != etiqueta) {
      throw const FormatException('DER inválido');
    }
  }

  BigInt leerEntero() {
    esperar(0x02);
    final len = leerLongitud();
    final bytes = der.sublist(pos, pos + len);
    pos += len;
    var inicio = 0;
    if (bytes.length > 1 && bytes[0] == 0x00) inicio = 1;
    return os2ip(Uint8List.sublistView(bytes, inicio));
  }

  esperar(0x30);
  leerLongitud();
  esperar(0x30);
  final lenAlg = leerLongitud();
  pos += lenAlg;
  esperar(0x03);
  final lenBit = leerLongitud();
  final finBit = pos + lenBit;
  if (der[pos++] != 0x00) {
    throw const FormatException('DER inválido');
  }
  esperar(0x30);
  leerLongitud();
  final n = leerEntero();
  final e = leerEntero();
  if (pos > finBit) {
    throw const FormatException('DER inválido');
  }
  if (n < (BigInt.one << 2047)) {
    throw StateError('clave RSA menor a 2048 bits');
  }
  return ClavePublicaRsa(n: n, e: e);
}

int longitudSal(String variante) {
  if (variante == 'RSABSSA-SHA384-PSS-Randomized') return _hashLen;
  if (variante == 'RSABSSA-SHA384-PSSZERO-Randomized') return 0;
  throw StateError('variante de firma ciega no soportada: $variante');
}

Uint8List sha384Bytes(Uint8List datos) =>
    Uint8List.fromList(sha384.convert(datos).bytes);

Uint8List mgf1(Uint8List semilla, int longitud) {
  final salida = Uint8List(longitud);
  var pos = 0;
  for (var contador = 0; pos < longitud; contador++) {
    final entrada = Uint8List(semilla.length + 4);
    entrada.setRange(0, semilla.length, semilla);
    entrada.setRange(
        semilla.length, entrada.length, i2osp(BigInt.from(contador), 4));
    final bloque = sha384Bytes(entrada);
    final n = bloque.length < longitud - pos ? bloque.length : longitud - pos;
    salida.setRange(pos, pos + n, bloque);
    pos += n;
  }
  return salida;
}

/// EMSA-PSS-ENCODE (RFC 8017) con SHA-384 y MGF1-SHA-384.
Uint8List codificarPss(Uint8List mensaje, int emBits, int sLen) {
  final emLen = (emBits + 7) >> 3;
  if (emLen < _hashLen + sLen + 2) {
    throw StateError('clave demasiado pequeña para PSS');
  }
  final mHash = sha384Bytes(mensaje);
  final sal = Uint8List.fromList(
      List.generate(sLen, (_) => Random.secure().nextInt(256)));
  final mPrima = Uint8List(8 + _hashLen + sLen);
  mPrima.setRange(8, 8 + _hashLen, mHash);
  mPrima.setRange(8 + _hashLen, mPrima.length, sal);
  final h = sha384Bytes(mPrima);
  final db = Uint8List(emLen - _hashLen - 1);
  db[db.length - sLen - 1] = 0x01;
  db.setRange(db.length - sLen, db.length, sal);
  final mascara = mgf1(h, db.length);
  for (var i = 0; i < db.length; i++) {
    db[i] ^= mascara[i];
  }
  db[0] &= 0xff >> (8 * emLen - emBits);
  final em = Uint8List(emLen);
  em.setRange(0, db.length, db);
  em.setRange(db.length, db.length + h.length, h);
  em[emLen - 1] = 0xbc;
  return em;
}

({Uint8List prepared, Uint8List nonce}) prepararToken(String electionId) {
  final nonce = generarNonce();
  final mensaje = mensajeCanonicoToken(electionId, nonce);
  final prefijo = Uint8List.fromList(
      List.generate(prefijoAleatorioSize, (_) => Random.secure().nextInt(256)));
  final prepared = Uint8List(prefijo.length + mensaje.length);
  prepared.setRange(0, prefijo.length, prefijo);
  prepared.setRange(prefijo.length, prepared.length, mensaje);
  return (prepared: prepared, nonce: nonce);
}

({Uint8List cegado, EstadoCegado estado}) cegarPss(
    Uint8List prepared, ClavePublicaRsa clave, String variante) {
  final codificado =
      codificarPss(prepared, clave.n.bitLength - 1, longitudSal(variante));
  final m = os2ip(codificado);
  if (m.gcd(clave.n) != BigInt.one) {
    throw StateError('mensaje codificado inválido para la clave');
  }
  final r = _enteroAleatorioMenorQue(clave.n);
  final cegadoEntero = (m * r.modPow(clave.e, clave.n)) % clave.n;
  return (
    cegado: i2osp(cegadoEntero, longitudModulo(clave.n)),
    estado: EstadoCegado(
        r: r,
        rInverso: _inversoModular(r, clave.n),
        n: clave.n,
        prepared: prepared),
  );
}

Uint8List finalizarPss(Uint8List firmaCegada, EstadoCegado estado,
    Uint8List claveDer, String variante) {
  final firma = _descegar(firmaCegada, estado);
  final clave = claveDesdeDerSpki(claveDer);
  if (!_verificarPss(estado.prepared, firma, clave, longitudSal(variante))) {
    throw StateError('la firma ciega devuelta por identidad no es válida');
  }
  return firma;
}

Uint8List _descegar(Uint8List firmaCegada, EstadoCegado estado) {
  final k = longitudModulo(estado.n);
  if (firmaCegada.length != k) {
    throw StateError('firma cegada con longitud incorrecta');
  }
  final s = (os2ip(firmaCegada) * estado.rInverso) % estado.n;
  return i2osp(s, k);
}

bool _verificarPss(
    Uint8List mensaje, Uint8List firma, ClavePublicaRsa clave, int sLen) {
  final emBits = clave.n.bitLength - 1;
  final emLen = (emBits + 7) >> 3;
  if (firma.length != longitudModulo(clave.n) || emLen < _hashLen + sLen + 2) {
    return false;
  }
  final s = os2ip(firma);
  if (s <= BigInt.zero || s >= clave.n) return false;
  final em = i2osp(s.modPow(clave.e, clave.n), emLen);
  if (em.last != 0xbc) return false;
  final dbLen = em.length - _hashLen - 1;
  final h = em.sublist(dbLen, dbLen + _hashLen);
  final bitsACero = 8 * emLen - emBits;
  if (bitsACero > 0 && (em[0] & (0xff << (8 - bitsACero))) != 0) return false;
  final db = Uint8List.fromList(em.sublist(0, dbLen));
  final mascara = mgf1(h, dbLen);
  for (var i = 0; i < dbLen; i++) {
    db[i] ^= mascara[i];
  }
  db[0] &= 0xff >> bitsACero;
  final finRelleno = dbLen - sLen - 1;
  for (var i = 0; i < finRelleno; i++) {
    if (db[i] != 0) return false;
  }
  if (db[finRelleno] != 0x01) return false;
  final sal = db.sublist(dbLen - sLen);
  final mPrima = Uint8List(8 + _hashLen + sLen);
  mPrima.setRange(8, 8 + _hashLen, sha384Bytes(mensaje));
  mPrima.setRange(8 + _hashLen, mPrima.length, sal);
  final h2 = sha384Bytes(mPrima);
  if (h.length != h2.length) return false;
  var distinto = 0;
  for (var i = 0; i < h.length; i++) {
    distinto |= h[i] ^ h2[i];
  }
  return distinto == 0;
}

BigInt _inversoModular(BigInt a, BigInt n) {
  var viejoR = a;
  var r = n;
  var viejoS = BigInt.one;
  var s = BigInt.zero;
  while (r != BigInt.zero) {
    final cociente = viejoR ~/ r;
    final tmpR = viejoR;
    viejoR = r;
    r = tmpR - cociente * r;
    final tmpS = viejoS;
    viejoS = s;
    s = tmpS - cociente * s;
  }
  if (viejoR != BigInt.one && viejoR != -BigInt.one) {
    throw StateError('sin inverso modular');
  }
  final resultado = viejoS % n;
  return resultado.isNegative ? resultado + n : resultado;
}

BigInt _enteroAleatorioMenorQue(BigInt n) {
  final k = longitudModulo(n);
  final random = Random.secure();
  for (var intento = 0; intento < 50; intento++) {
    final buf =
        Uint8List.fromList(List.generate(k, (_) => random.nextInt(256)));
    final candidato = os2ip(buf) % n;
    if (candidato > BigInt.one &&
        candidato < n - BigInt.one &&
        candidato.gcd(n) == BigInt.one) {
      return candidato;
    }
  }
  throw StateError('no se pudo generar factor de cegado');
}
