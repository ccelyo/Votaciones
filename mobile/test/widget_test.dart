import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:votaciones_mobile/main.dart';
import 'package:votaciones_mobile/src/gateway.dart';

void main() {
  testWidgets('la pantalla de entrada muestra usuario y contraseña',
      (tester) async {
    final gateway = GatewayClient(
      baseUrl: 'http://gateway.test',
      httpClient: MockClient((request) async => http.Response('{}', 200)),
    );
    await tester.pumpWidget(VotacionesApp(gateway: gateway));
    expect(find.text('Votaciones'), findsOneWidget);
    expect(find.text('Usuario'), findsOneWidget);
    expect(find.text('Contraseña'), findsOneWidget);
  });
}
