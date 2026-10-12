# Identity (Python)

Servicio de la **zona de identidad**. Este README cubre el frente de M6: **urnas**, **token
anónimo (firma ciega)** y **cliente gRPC hacia `ballot`**. Login/MFA, roles y padrón
(PostgreSQL) son de M5.

## Qué sabe y qué no sabe identidad

Identidad conoce `usuario → recibió token` y **nada más**. No guarda el mensaje cegado ni la
firma devuelta, así que no puede enlazar al usuario con la papeleta que llegue a `ballot`.

## Estructura

| Archivo | Responsabilidad |
|---|---|
| `app/api.py` | Endpoints HTTP (REST/JSON) |
| `app/elections.py` | Alta, cierre y estado de urnas; registro en `ballot` |
| `app/tokens.py` | Emisión del token: urna abierta, padrón, `UNIQUE(user_id, election_id)` |
| `app/blind_rsa.py` | `BlindSign` de RFC 9474 (RSABSSA-SHA384-PSS-Randomized) |
| `app/parameters.py` | Parámetros públicos canónicos y su firma Ed25519 |
| `app/ballot_client.py` | Cliente gRPC de `BallotAdminService` (`proto/ballot.proto`) |
| `app/keys.py` | Claves privadas (RSA de tokens, Ed25519 de parámetros) |
| `app/models.py` | `elections`, `issued_tokens` y `voter_roll` (PostgreSQL) |
| `app/auth.py` | Contrato `Principal` + autenticación **provisional** (ver abajo) |
| `app/pb/` | Stubs generados desde `proto/ballot.proto` (versionados) |

## Endpoints

| Método y ruta | Acceso | Descripción |
|---|---|---|
| `POST /elections` | admin | Crea la urna, firma sus parámetros y la registra en `ballot` por gRPC |
| `POST /elections/{id}/close` | admin | Cierra la urna en `ballot` (irreversible, idempotente) y en PostgreSQL |
| `GET /elections/{id}/status` | admin | Estado en ambos lados y participación (`CountBallots`) |
| `GET /elections/{id}/parameters` | público | Parámetros firmados que descarga el navegador |
| `GET /keys` | público | Claves públicas de identidad (token y firma de parámetros) |
| `POST /tokens/blind` | votante | Firma ciega del token. Body: `{"election_id", "blinded_token"}` (base64url) |
| `GET /health` | público | Liveness |

Errores: `{"error": {"code": "...", "message": "..."}}`. Códigos principales:
`401 unauthenticated`, `403 forbidden | not_in_voter_roll`, `404 election_not_found`,
`409 election_already_exists | election_not_open | token_already_issued`,
`400 invalid_request`, `502 ballot_unavailable`.

## Flujo del token anónimo

1. El navegador baja `GET /elections/{id}/parameters` y verifica la firma Ed25519.
2. Genera `nonce` (32 bytes) y el mensaje
   `"votaciones.ballot.anonymous-token.v1\0" || uint16_be(len(election_id)) || election_id || nonce`,
   antepone el prefijo aleatorio RFC 9474 de 32 bytes y lo **ciega** con la clave `token_key`.
3. `POST /tokens/blind` con el mensaje cegado (debe medir exactamente el módulo RSA: 256 bytes).
4. Identidad comprueba urna abierta y padrón, firma a ciegas y registra la emisión.
   Un mensaje inválido **no consume** el derecho al token; un segundo intento da `409`.
5. El navegador **desciega**, verifica y arma el sobre del token que entiende `ballot`
   (`ballot/docs/qa/happy-path.md`).

## Decisiones propuestas (pendientes de acuerdo)

- **Parámetros firmados** (M1/M4): JSON canónico (claves ordenadas, sin espacios, ASCII) con
  `v, election_id, options, encryption_public_key, opens_at, closes_at, token_key`; firma Ed25519
  sobre `"votaciones.identity.election-parameters.v1\0" || bytes`. `ballot` los guarda sin
  interpretarlos en el Prototype 1.
- **Clave de tokens**: una RSA de 2048 bits de identidad, con `kid` = primeros 16 hex del SHA-256
  de su SPKI DER, registrada en cada elección. La rotación usa `AddTokenVerificationKey`
  (el cliente ya lo expone; aún no hay endpoint que lo dispare).
- **Clave de cifrado de la elección**: la aporta el administrador al crear la urna; identidad
  nunca ve la clave privada.

## Pendiente de otros frentes

- **M5**: reemplazar `app/auth.py::get_principal` por la sesión real (login + MFA + roles) y
  adueñarse de `voter_roll`. Hoy `IDENTITY_DEV_AUTH=true` acepta las cabeceras `X-Dev-User` y
  `X-Dev-Roles`; está **apagado por defecto** y no debe usarse fuera de desarrollo.
- **M5/M1**: la confirmación "usuario votó" (`/vote-confirmation`) no está implementada.
- **M2**: Dockerfile y mTLS del canal gRPC (hoy `grpc.insecure_channel`, igual que el listener de `ballot`).
- **M8**: ejecutar un token real firmado por este servicio contra el verificador Go.

## Configuración (variables de entorno, prefijo `IDENTITY_`)

| Variable | Defecto | Uso |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://identity:identity@localhost:5432/identity` | PostgreSQL |
| `BALLOT_GRPC_ADDR` | `127.0.0.1:9091` | Listener gRPC interno de `ballot` |
| `BALLOT_GRPC_TIMEOUT_SECONDS` | `5` | Deadline por llamada |
| `KEYS_DIR` | `./keys` | Claves privadas; se crean con `0600` si faltan. Están en `.gitignore` |
| `DEV_AUTH` | `false` | Autenticación simulada (solo desarrollo) |

Las tablas se crean al arrancar (`create_all`); el Prototype 1 no usa migraciones.

## Ejecutar

```bash
cd identity
uv sync
IDENTITY_DEV_AUTH=true uv run python main.py     # http://localhost:8000/docs
uv run pytest                                      # 37 pruebas
```

## Regenerar los stubs gRPC

Ver `proto/README.md` (incluye la corrección del import relativo).
