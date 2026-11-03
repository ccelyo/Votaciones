import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:votaciones_mobile/src/gateway.dart';
import 'package:votaciones_mobile/src/protocol/blind.dart';
import 'package:votaciones_mobile/src/protocol/codec.dart';
import 'package:votaciones_mobile/src/protocol/encrypt.dart';
import 'package:votaciones_mobile/src/protocol/token.dart';

void main() {
  test('el mensaje canónico coincide con el de ballot', () {
    final nonce = Uint8List.fromList(List.generate(32, (i) => i + 1));
    final mensaje = mensajeCanonicoToken('eleccion-1', nonce);
    expect(
      mensaje.map((b) => b.toRadixString(16).padLeft(2, '0')).join(),
      '766f746163696f6e65732e62616c6c6f742e616e6f6e796d6f75732d746f6b656e2e763100000a656c656363696f6e2d310102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
    );
  });

  test('base64url no usa padding', () {
    expect(aBase64Url(Uint8List.fromList(utf8.encode('candidato-1'))),
        'Y2FuZGlkYXRvLTE');
    expect(utf8.decode(deBase64Url('Y2FuZGlkYXRvLTE')), 'candidato-1');
  });

  test('el cifrado de prototipo es la opción en claro y la prueba stub', () {
    final voto = cifrarOpcion('candidata-1');
    expect(utf8.decode(voto.ciphertext), 'candidata-1');
    expect(utf8.decode(voto.proof), 'stub-benaloh-proof');
  });

  test('EMSA-PSS termina en 0xbc y tiene el largo del módulo', () {
    final em =
        codificarPss(Uint8List.fromList(utf8.encode('mensaje')), 2047, 48);
    expect(em.length, 256);
    expect(em.last, 0xbc);
  });

  test('la ruta anónima no reenvía la sesión', () async {
    final headers = <Map<String, String>>[];
    final gateway = GatewayClient(
      baseUrl: 'http://gateway.test',
      httpClient: MockClient((request) async {
        headers.add(request.headers);
        return http.Response('{}', 200);
      }),
    );
    gateway.accessToken = 'sesion-del-votante';
    await gateway.post('/api/ballots', {'election_id': '1'}, anonymous: true);
    await gateway.post('/api/identity/tokens/blind', {'election_id': '1'});
    expect(headers[0].containsKey('authorization'), isFalse);
    expect(headers[1]['authorization'], 'Bearer sesion-del-votante');
  });
}
