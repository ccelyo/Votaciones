# App móvil

Cliente en Flutter para votar a través del API Gateway. No se conecta a MongoDB.

El teléfono hace lo mismo que la web:

1. Entra con usuario, contraseña y el código MFA. El Gateway devuelve la sesión.
2. Pide las elecciones abiertas y los parámetros de la urna.
3. Ciega el token (`RSABSSA-SHA384-PSS-Randomized`) y se lo envía a Identity **con** la sesión: `POST /api/identity/tokens/blind`.
4. Desciega la firma y envía la papeleta **sin** la sesión: `POST /api/ballots`.
5. Después pide a Identity que marque al votante: `POST /api/identity/vote-confirmation`.

En este prototipo la papeleta lleva la opción en texto claro, igual que la web. El token sigue siendo anónimo.

## Ejecutar en el teléfono o el simulador

El Gateway tiene que estar arriba (`docker compose up` en la raíz del repo).

```bash
cd mobile
flutter pub get
flutter run --dart-define=GATEWAY_URL=http://localhost:8088
```

La URL cambia según dónde corre la app:

| Dónde | `GATEWAY_URL` |
| --- | --- |
| Simulador de iOS o escritorio | `http://localhost:8088` |
| Emulador de Android | `http://10.0.2.2:8088` |
| Teléfono en la misma red | `http://IP-DE-TU-COMPUTADORA:8088` |

Usuarios de prueba del compose: `votante1` … `votante10`, contraseña `prueba123`, código `123456`.

## Vista web de la misma app

Sirve para ver el flujo sin un teléfono. El navegador llama al Gateway en tu máquina.

```bash
docker compose up --build mobile
```

Queda en `http://localhost:8092`.

## Contenedor

`Dockerfile` compila la app web y la publica con nginx. La URL del Gateway se fija al construir:

```bash
docker build --build-arg GATEWAY_URL=http://localhost:8088 -t votaciones-mobile mobile
docker run --rm -p 8092:80 votaciones-mobile
```
