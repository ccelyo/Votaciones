# Auth, PostgreSQL y CLI Admin (frente de Julian)

Objetivo: que un administrador se autentique, obtenga un token válido y use la CLI para
ejecutar las operaciones administrativas autorizadas.

## Estado por actividad

| ID | Entregable | Dónde |
|---|---|---|
| JU-01 | Inventario de autenticación reutilizable del prototipo 1 | Sección siguiente |
| JU-02 | Servicio de autenticación en Python | `identity/` (FastAPI): `app/login.py`, `app/sessions.py`, `app/auth.py` |
| JU-03 | Esquema y persistencia en PostgreSQL | `identity/schema.sql` (`users`, `roles`, `mfa_challenges`, `sessions`), `tests/test_schema.py` |
| JU-04 | Gestión de usuarios | `POST /users`, `PATCH /users/{id}`, `GET /users` (`app/users.py`) |
| JU-05 | JWT compatible con el Gateway | `app/jwt_tokens.py`, `GET /.well-known/jwks.json`; contrato en `identity/README.md` |
| JU-06 | CLI administrativa en Java | `admin-cli/` (jar ejecutable `votaciones-admin.jar`) |
| JU-07 | Comandos de administración | `elections create/open/close/status/tally/results`, `voters`, `users` |
| JU-08 | Pruebas y documentación | `identity/tests/test_jwt.py`, `test_users.py`, `test_api.py`; `admin-cli/src/test`; READMEs |

## JU-01 — Inventario del prototipo 1

| Funcionalidad existente | Se reutiliza | Cambio |
|---|---|---|
| Login usuario/contraseña con hash argon2id (`pwdlib`) | Sí | — |
| MFA con challenge de un solo uso y TTL (`mfa_challenges`) | Sí | — |
| Sesión Bearer opaca guardada como SHA-256 (`sessions`) | Parcial | El Bearer pasa a ser un **JWT RS256**; la tabla guarda el hash del `jti` para poder revocar en `/logout` |
| `Principal` + `require_admin` en FastAPI | Sí | Valida el JWT y la sesión; el rol sale de la BD |
| Roles `admin` / `voter` en `roles` | Sí | — |
| Usuarios solo por SQL (`seed_dev_users.sql`) | No basta | Nuevo alta/activación por API para el administrador |
| Urnas: alta (directa a `open`), cierre, estado | Sí | Alta en `draft` opcional y `POST /elections/{id}/open` |
| Padrón (`voter_roll`) | Sí | — |
| Conteo en ballot (`GET /v1/elections/{id}/results`) | Sí | La CLI lo usa sin credenciales |
| Modo de desarrollo `X-Dev-User` | Solo pruebas | Desactivado por defecto |

## Acuerdo con el Gateway (Cristhian)

- **Firma:** RS256 con clave de identidad; pública en `GET /.well-known/jwks.json` (por `kid`).
  Sin secretos compartidos. La clave es distinta de la de firma ciega de tokens de voto.
- **Claims:** `iss=votaciones-identity`, `aud=votaciones`, `sub`, `username`, `role`, `iat`,
  `nbf`, `exp` (1 h por defecto), `jti`.
- **Validación:** solo `RS256`; `iss`, `aud`, `exp`, `nbf` con ≤ 30 s de tolerancia; `role=admin`
  para rutas de administración; no reenviar el JWT hacia `ballot`.
- **Revocación:** identidad revoca por `jti` al instante; el Gateway sin estado lo acepta hasta `exp`.

## Criterio de aceptación — evidencia

Ejecutado contra el servicio `identity` real (SQLite local y un `ballot` simulado por gRPC):

```text
$ votaciones-admin login -u admin1 --password-stdin --mfa-code 123456
Sesión iniciada como admin1 (admin) en http://127.0.0.1:18000. Expira: 2026-11-02T20:20:05.
$ votaciones-admin elections create --name "Consejo Estudiantil 2026" --option Alpha --option Beta --option "Voto en blanco" --duration 8h --encryption-key cHVibGlj --draft
Urna 1 creada (draft).
$ votaciones-admin elections open 1
Urna 1: open.
$ votaciones-admin elections tally 1 --yes
Urna 1 cerrada.
Resultados de la urna 1
OPCIÓN          VOTOS  %
Alpha           2      66.7%
Beta            1      33.3%
Voto en blanco  0      0.0%
Papeletas: 3 (válidas 3, inválidas 0)
$ votaciones-admin logout
Sesión cerrada.
$ votaciones-admin whoami
No hay sesión. Ejecuta: votaciones-admin login        (código de salida 3)
```

Pruebas automatizadas: `cd identity && uv run pytest -q` (92) y `cd admin-cli && ./mvnw test` (27).

## Pendiente

- Confirmar con Cristhian el contrato JWT de arriba e integrarlo en el Gateway.
- Desplegar: la nueva clave `jwt_signing.pem` se crea sola en el primer arranque dentro de
  `IDENTITY_KEYS_DIR` (en Cloud Run, el bucket montado en `/app/keys`).
- Las sesiones opacas emitidas antes de este cambio dejan de valer: hay que volver a iniciar sesión.
