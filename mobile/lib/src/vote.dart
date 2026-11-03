import 'dart:typed_data';

import 'gateway.dart';
import 'protocol/blind.dart';
import 'protocol/codec.dart';
import 'protocol/encrypt.dart';
import 'protocol/token.dart';

class ClaveToken {
  const ClaveToken(
      {required this.kid, required this.publicKeyDer, required this.variant});

  final String kid;
  final Uint8List publicKeyDer;
  final String variant;
}

class ParametrosUrna {
  const ParametrosUrna({
    required this.electionId,
    required this.name,
    required this.options,
    required this.tokenKey,
  });

  final String electionId;
  final String name;
  final List<String> options;
  final ClaveToken tokenKey;
}

class ReciboVoto {
  const ReciboVoto(
      {required this.recibo,
      required this.hashPapeleta,
      required this.reintento});

  final String recibo;
  final String hashPapeleta;
  final bool reintento;
}

class EleccionAbierta {
  const EleccionAbierta({required this.id, required this.name});

  final String id;
  final String name;
}

Future<List<EleccionAbierta>> eleccionesAbiertas(GatewayClient gateway) async {
  final body = await gateway.get('/api/elections/open', anonymous: true);
  if (body is! List) return const [];
  return [
    for (final item in body)
      if (item is Map)
        EleccionAbierta(
          id: '${item['id']}',
          name: item['name'] is String
              ? item['name'] as String
              : 'Elección ${item['id']}',
        ),
  ];
}

Future<ParametrosUrna> parametrosUrna(
    GatewayClient gateway, String electionId) async {
  final body = await gateway
      .get('/api/elections/${Uri.encodeComponent(electionId)}/parameters');
  if (body is! Map) {
    throw GatewayException(502, 'La elección no entregó sus parámetros.');
  }
  final options = body['options'];
  final tokenKey = body['token_key'];
  if (options is! List || tokenKey is! Map) {
    throw GatewayException(
        502, 'Los parámetros de la elección están incompletos.');
  }
  return ParametrosUrna(
    electionId: body['election_id'] is String
        ? body['election_id'] as String
        : electionId,
    name: body['name'] is String
        ? body['name'] as String
        : 'Elección $electionId',
    options: [for (final option in options) '$option'],
    tokenKey: ClaveToken(
      kid: '${tokenKey['kid']}',
      publicKeyDer: deBase64Url('${tokenKey['public_key_der']}'),
      variant: '${tokenKey['variant']}',
    ),
  );
}

/// Pide el token con la sesión y envía la papeleta sin ella.
Future<ReciboVoto> emitirPapeleta(
    GatewayClient gateway, ParametrosUrna parametros, String opcion) async {
  if (!parametros.options.contains(opcion)) {
    throw StateError('Selecciona una opción válida.');
  }
  final preparado = prepararToken(parametros.electionId);
  final cegado = cegarPss(
    preparado.prepared,
    claveDesdeDerSpki(parametros.tokenKey.publicKeyDer),
    parametros.tokenKey.variant,
  );
  final Map firma;
  try {
    final respuesta = await gateway.post('/api/identity/tokens/blind', {
      'election_id': parametros.electionId,
      'blinded_token': aBase64Url(cegado.cegado),
    });
    if (respuesta is! Map) {
      throw GatewayException(502, 'Identidad no devolvió la firma del token.');
    }
    firma = respuesta;
  } on GatewayException catch (error) {
    if (error.status == 409) {
      throw GatewayException(409, 'Ya se emitió tu token para esta elección.');
    }
    if (error.status == 403) {
      throw GatewayException(
          403, 'No estás habilitado en el padrón de esta elección.');
    }
    rethrow;
  }
  final signature = finalizarPss(
    deBase64Url('${firma['blind_signature']}'),
    cegado.estado,
    parametros.tokenKey.publicKeyDer,
    '${firma['variant']}',
  );
  final sobre = serializarSobre(SobreToken(
    version: tokenVersion,
    kid: '${firma['kid']}',
    electionId: parametros.electionId,
    nonce: preparado.nonce,
    preparedMessage: preparado.prepared,
    signature: signature,
  ));
  final voto = cifrarOpcion(opcion);
  final respuesta = await gateway.post(
      '/api/ballots',
      {
        'election_id': parametros.electionId,
        'token': sobre,
        'encrypted_vote': aBase64Url(voto.ciphertext),
        'proof': aBase64Url(voto.proof),
      },
      anonymous: true);
  if (respuesta is! Map || respuesta['receipt'] is! String) {
    throw GatewayException(502, 'La urna no devolvió un recibo.');
  }
  try {
    await gateway.post('/api/identity/vote-confirmation',
        {'election_id': parametros.electionId});
  } on GatewayException {
    // La papeleta ya quedó guardada. La marca del padrón puede reintentarse.
  }
  return ReciboVoto(
    recibo: respuesta['receipt'] as String,
    hashPapeleta: respuesta['ballot_hash'] is String
        ? respuesta['ballot_hash'] as String
        : '',
    reintento: respuesta['replayed'] == true,
  );
}
