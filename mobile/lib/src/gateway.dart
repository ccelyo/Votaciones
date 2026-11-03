import 'dart:convert';

import 'package:http/http.dart' as http;

class GatewayException implements Exception {
  GatewayException(this.status, this.message);

  final int status;
  final String message;

  @override
  String toString() => message;
}

/// Cliente del API Gateway. La papeleta usa [anonymous] para no enviar la sesión.
class GatewayClient {
  GatewayClient({required this.baseUrl, http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _http;
  String? accessToken;

  Uri _uri(String path) {
    final root = baseUrl.endsWith('/')
        ? baseUrl.substring(0, baseUrl.length - 1)
        : baseUrl;
    return Uri.parse('$root$path');
  }

  Future<dynamic> get(String path, {bool anonymous = false}) {
    return _send('GET', path, anonymous: anonymous);
  }

  Future<dynamic> post(String path, Map<String, dynamic> body,
      {bool anonymous = false}) {
    return _send('POST', path, body: body, anonymous: anonymous);
  }

  Future<dynamic> _send(String method, String path,
      {Map<String, dynamic>? body, required bool anonymous}) async {
    final headers = <String, String>{
      'Accept': 'application/json',
      if (body != null) 'Content-Type': 'application/json',
    };
    if (!anonymous && accessToken != null) {
      headers['Authorization'] = 'Bearer $accessToken';
    }
    final uri = _uri(path);
    late http.Response response;
    try {
      final request = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) request.body = jsonEncode(body);
      final streamed =
          await _http.send(request).timeout(const Duration(seconds: 20));
      response = await http.Response.fromStream(streamed);
    } catch (error) {
      throw GatewayException(0,
          'No se pudo contactar el servidor. Revisa que el Gateway esté encendido.');
    }
    if (response.statusCode == 204) return null;
    final decoded = response.body.isEmpty ? null : _decode(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw GatewayException(
          response.statusCode, _mensaje(decoded, response.statusCode));
    }
    return decoded;
  }

  dynamic _decode(String body) {
    try {
      return jsonDecode(body);
    } catch (_) {
      return body;
    }
  }

  String _mensaje(dynamic body, int status) {
    if (body is Map) {
      final detail = body['detail'];
      if (detail is String && detail.isNotEmpty) return detail;
      final error = body['error'];
      if (error is Map && error['message'] is String) {
        return error['message'] as String;
      }
      if (error is String && error.isNotEmpty) return error;
    }
    if (body is String && body.isNotEmpty) return body;
    return 'Error del servidor ($status).';
  }

  void close() => _http.close();
}
