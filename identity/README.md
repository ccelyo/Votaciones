# Identity (Python)

Servicio de la **zona de identidad**. Este README cubre el frente de M6: **urnas**, **token
anónimo (firma ciega)** y **cliente gRPC hacia `ballot`**. Login/MFA, roles y padrón
(PostgreSQL) son de M5.

## Qué sabe y qué no sabe identidad

Identidad conoce `usuario → recibió token` y **nada más**. No guarda el mensaje cegado ni la
firma devuelta, así que no puede enlazar al usuario con la papeleta que llegue a `ballot`.

## Esquema de base de datos

La fuente de verdad es **`schema.sql`** (Kevin). Se usa tal cual (`roles`, `users`, `elections`,
`voter_roll`, `issued_tokens`) más **una tabla nueva**, `election_parameters`, 1 a 1 con
`elections`: guarda lo que `ballot` exige y `elections` no tiene (opciones, clave de cifrado,
clave de verificación de tokens y parámetros firmados).

- **`election_id` hacia fuera es el texto de `elections.id`** (`"1"`, `"2"`…). Es lo que recibe
  `ballot`, lo que va dentro del token y lo que usa la URL. Solo `app/elections.py` convierte
  entre ese texto y el entero de PostgreSQL. No hace falta cambiar `elections.id` a texto.
- `starts_at` / `ends_at` son `TIMESTAMP` sin zona: se interpretan siempre como **UTC**.
- `user_id` es el `users.id` entero y nunca sale de identidad.
- `tests/test_schema.py` compara los modelos con `schema.sql` y falla si se desfasan.

## Estructura

| Archivo | Responsabilidad |
|---|---|
| `main.py` | `uvicorn main:app` (reexporta `app.main:app`) |
| `app/api.py` | Endpoints HTTP (REST/JSON) |
| `app/elections.py` | Alta, cierre y estado de urnas; registro en `ballot` |
| `app/tokens.py` | Emisión del token: urna abierta, padrón, `UNIQUE(user_id, election_id)` |
| `app/blind_rsa.py` | `BlindSign` de RFC 9474 (RSABSSA-SHA384-PSS-Randomized) |
| `app/parameters.py` | Parámetros públicos canónicos y su firma Ed25519 |
| `app/ballot_client.py` | Cliente gRPC de `BallotAdminService` (`proto/ballot.proto`) |
| `app/keys.py` | Claves privadas (RSA de tokens, Ed25519 de parámetros) |
| `app/models.py` | Modelos que reflejan `schema.sql` |
| `app/auth.py` | Contrato `Principal` + autenticación **provisional** (ver abajo) |
| `app/pb/` | Stubs generados desde `proto/ballot.proto` (versionados) |

## Endpoints

| Método y ruta | Acceso | Descripción |
|---|---|---|
| `POST /elections` | admin | Crea la urna, firma sus parámetros y la registra en `ballot` por gRPC |
| `POST /elections/{id}/close` | admin | Cierra la urna en `ballot` (irreversible, idempotente) y en PostgreSQL |
| `GET /elections/{id}/status` | admin | Estado en ambos lados y participación (`CountBallots`) |
| `GET /elections/{id}/parameters` | sesión | Parámetros firmados que descarga el navegador |
| `POST /tokens/blind` | votante | Firma ciega del token. Body: `{"election_id", "blinded_token"}` (base64url) |
| `GET /keys` | público | Claves públicas de identidad (token y firma de parámetros) |
| `GET /`, `GET /health` | público | Liveness |

`POST /elections` recibe `{name, options[], encryption_public_key (base64url), opens_at, closes_at}`
(epoch en segundos UTC) y responde `{election_id, status}`. La fila se crea como `draft` y pasa a
`open` solo cuando `ballot` confirma el registro; si `ballot` falla se revierte todo.

Errores: `{"error": {"code": "...", "message": "..."}}`. Códigos principales:
`401 unauthenticated`, `403 forbidden | not_in_voter_roll`, `404 election_not_found`,
`409 election_not_open | token_already_issued`, `400 invalid_request`, `502 ballot_unavailable`.

## Flujo del token anónimo

1. El navegador baja `GET /elections/{id}/parameters` y verifica la firma Ed25519.
2. Genera `nonce` (32 bytes) y el mensaje
   `"votaciones.ballot.anonymous-token.v1\0" || uint16_be(len(election_id)) || election_id || nonce`,
   antepone el prefijo aleatorio RFC 9474 de 32 bytes y lo **ciega** con `token_key`.
3. `POST /tokens/blind` con el mensaje cegado (debe medir exactamente el módulo RSA: 256 bytes).
4. Identidad comprueba urna abierta y padrón (`is_eligible`), firma a ciegas y registra la emisión.
   Un mensaje inválido **no consume** el derecho al token; un segundo intento da `409`.
5. El navegador **desciega**, verifica y arma el sobre del token que entiende `ballot`
   (`ballot/docs/qa/happy-path.md`).

### Para M4 (cliente en el navegador)

El servidor solo hace `BlindSign` (`s = m^d mod n`), pero **`m` debe ser el mensaje codificado con
EMSA-PSS**, no el `prepared` en crudo. `lib/m4/blind.ts` hoy hace `os2ip(prepared)` directamente y por
eso las firmas no verificarían en Go. Lo que falta (RFC 9474, SHA-384, MGF1-SHA384, `sLen = 48`):

1. `EM = EMSA-PSS-ENCODE(prepared, emBits = bitlen(n) - 1)`; `m = OS2IP(EM)`.
2. `blinded = m · r^e mod n`; `inv = r⁻¹ mod n`.
3. `sig = blind_sig · inv mod n` y **verificar** `RSASSA-PSS-VERIFY(prepared, sig)` antes de usarla.

Referencia ejecutable: `tests/rsabssa_client.py` (≈80 líneas). Vectores para comprobar el TS:
`ballot/internal/token/testdata/rfc9474.json.gz` (traen `input_msg`, `salt`, `inv`, `blinded_msg`,
`blind_sig` y `sig`; con `salt` e `inv` fijos el resultado debe coincidir byte a byte).

### Para M3/M4 (nombres de campo)

La API usa `snake_case` en inglés (como `01-Prototype.md §15`). Equivalencias con `lib/m4/api.ts`:

| `ParametrosEleccion` (front) | `GET /elections/{id}/parameters` |
|---|---|
| `electionId` | `election_id` |
| `opciones` | `options` |
| `claveCifradoB64` | `encryption_public_key` (base64url, **sin** relleno) |
| `parametrosFirmadosB64` | `signed_parameters` |
| `firmaParametrosB64` | `signature.value` |
| `algoritmoFirma` / `kidFirma` | `signature.algorithm` / `signature.key_id` |
| *(no existe)* | `token_key.public_key_der` (SPKI DER): **la necesita el cegado** |

Todo va en **base64url sin relleno**, no base64 estándar (`btoa`).

## Decisiones propuestas (pendientes de acuerdo)

- **Parámetros firmados** (M1/M4): JSON canónico (claves ordenadas, sin espacios, ASCII) con
  `v, election_id, name, options, encryption_public_key, opens_at, closes_at, token_key`; firma Ed25519
  sobre `"votaciones.identity.election-parameters.v1\0" || bytes`. `ballot` los guarda sin
  interpretarlos en el Prototype 1.
- **Clave de tokens**: una RSA de 2048 bits de identidad, con `kid` = primeros 16 hex del SHA-256
  de su SPKI DER, registrada en cada elección. La rotación usa `AddTokenVerificationKey`
  (el cliente ya lo expone; aún no hay endpoint que lo dispare).
- **Clave de cifrado de la elección**: la aporta el administrador al crear la urna; identidad
  nunca ve la clave privada.
- `GET /elections/{id}/parameters` exige sesión (como asume `lib/m4/api.ts`), aunque su contenido es público.

## Pendiente de otros frentes

- **M5**: reemplazar `app/auth.py::get_principal` por la sesión real (login + MFA + roles).
  Hoy `IDENTITY_DEV_AUTH=true` acepta `X-Dev-User` (id numérico de `users`) y `X-Dev-Roles`; está
  **apagado por defecto** y no debe usarse fuera de desarrollo.
- **M5/M1**: la confirmación "usuario votó" (`has_voted`, `/vote-confirmation`) no está implementada.
- **M2**: Dockerfile, carga de `schema.sql` al iniciar PostgreSQL y mTLS del canal gRPC
  (hoy `grpc.insecure_channel`, igual que el listener de `ballot`).
- **M8**: ejecutar un token real firmado por este servicio contra el verificador Go.

## Configuración (variables de entorno)

| Variable | Defecto | Uso |
|---|---|---|
| `DATABASE_URL` o `IDENTITY_DATABASE_URL` | `postgresql+psycopg://user:password@localhost:5432/votaciones` | PostgreSQL. Acepta el formato `postgresql://` de `.env.example` |
| `IDENTITY_AUTO_CREATE_TABLES` | `false` | Crea tablas al arrancar (solo desarrollo; la fuente es `schema.sql`) |
| `IDENTITY_BALLOT_GRPC_ADDR` | `127.0.0.1:9091` | Listener gRPC interno de `ballot` |
| `IDENTITY_BALLOT_GRPC_TIMEOUT_SECONDS` | `5` | Deadline por llamada |
| `IDENTITY_KEYS_DIR` | `./keys` | Claves privadas; se crean con `0600` si faltan. Están en `.gitignore` |
| `IDENTITY_DEV_AUTH` | `false` | Autenticación simulada (solo desarrollo) |

## Ejecutar

```bash
cd identity
uv sync
psql "$DATABASE_URL" -f schema.sql                 # una vez, sobre una base vacía
IDENTITY_DEV_AUTH=true uv run uvicorn main:app     # http://localhost:8000/docs
uv run pytest                                       # 45 pruebas
```

## Regenerar los stubs gRPC

Ver `proto/README.md` (incluye la corrección del import relativo).
