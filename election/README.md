# Election

**Responsable:** Fabian · **Tecnologías:** Python (FastAPI, SQLAlchemy), PostgreSQL «Elections», RabbitMQ

Administra las elecciones, custodia las llaves de la urna y publica `election.events`.

```
API Gateway ──REST──▶ Election ──SQL──▶ PostgreSQL «Elections»
                         │
                         └──pub──▶ RabbitMQ  election.events ──▶ Analytics, Notifications, Ballot
```

| Entregable | Dónde |
| --- | --- |
| FA-01 Modelo entidad-relación | [`docs/modelo-datos.md`](docs/modelo-datos.md) |
| FA-02 Esquema de base de datos | [`schema.sql`](schema.sql) |
| FA-03 Servicio de gestión | `app/service.py` |
| FA-04 Endpoints HTTP | `app/api.py` y la tabla de abajo |
| FA-05 Reglas de negocio | [`docs/reglas-negocio.md`](docs/reglas-negocio.md), `app/rules.py` |
| FA-06 Productor `election.events` | [`docs/eventos.md`](docs/eventos.md), `app/events.py` |
| FA-07 Pruebas | `tests/` |
| FA-08 Contenedor y configuración | `Dockerfile`, `.env.example`, servicios `election` y `postgres-elections` en `docker-compose.yml` |
| FA-09 Llaves de la urna | `app/keys.py` y la sección de abajo |

## API

Errores: `{"error": {"code": "...", "message": "..."}}`. Fechas: RFC 3339 en UTC
(`2026-11-20T13:00:00Z`). `{id}` es el texto de `elections.id`.

| Método | Ruta | Acceso | Descripción |
| --- | --- | --- | --- |
| GET | `/health` · `/ready` | público | Salud; `/ready` comprueba la base e informa si hay eventos atrasados |
| GET | `/keys` | público | Llave Ed25519 que firma los parámetros |
| GET | `/elections/open` | público | Elecciones que aceptan votos ahora |
| GET | `/elections?status=draft\|open\|closed` | admin | Todas, las más recientes primero |
| POST | `/elections` | admin | Crea un borrador (201) |
| GET | `/elections/{id}` | usuario | Detalle (los borradores solo para admin) |
| PATCH | `/elections/{id}` | admin | Edita un borrador |
| DELETE | `/elections/{id}` | admin | Borra un borrador (204) |
| POST | `/elections/{id}/open` | admin | Genera la llave de la urna, firma los parámetros y publica |
| POST | `/elections/{id}/close` | admin | Cierra la urna (idempotente) |
| GET | `/elections/{id}/status` | admin | Estado, fase y si acepta papeletas |
| GET | `/elections/{id}/parameters` | usuario | Opciones, ventana, llave pública de la urna y firma |
| POST | `/elections/{id}/urn-key/private` | admin | Llave privada de una urna **cerrada**, para Tally |

Ejemplo:

```bash
# Cabeceras de desarrollo (ELECTION_DEV_AUTH=true); con JWT: -H "Authorization: Bearer $TOKEN"
ADMIN=(-H 'X-Dev-User: 1' -H 'X-Dev-Roles: admin')
curl -s "${ADMIN[@]}" localhost:8001/elections -H 'Content-Type: application/json' -d '{
  "name": "Consejo Superior 2026",
  "options": ["Candidata A", "Candidato B", "Voto en blanco"],
  "blank_option": "Voto en blanco",
  "opens_at": "2026-11-20T13:00:00Z",
  "closes_at": "2026-11-20T21:00:00Z"
}'
curl -s "${ADMIN[@]}" -X POST localhost:8001/elections/1/open
curl -s localhost:8001/elections/open
```

`GET /elections/{id}/parameters`:

```json
{
  "election_id": "1",
  "name": "Consejo Superior 2026",
  "status": "open",
  "phase": "voting",
  "options": ["Candidata A", "Candidato B", "Voto en blanco"],
  "blank_option": "Voto en blanco",
  "opens_at": "2026-11-20T13:00:00Z",
  "closes_at": "2026-11-20T21:00:00Z",
  "encryption": { "algorithm": "RSA-OAEP-256+A256GCM", "public_key": "<SPKI DER b64url>", "public_key_format": "spki-der" },
  "signed_parameters": "<b64url>",
  "signature": { "key_id": "…", "algorithm": "Ed25519", "value": "<b64url>" }
}
```

## Autenticación

El servicio valida el JWT HS256 de Auth con el mismo contrato que el Gateway
(`sub`, `exp`, `roles`/`role`; `iss`/`aud` opcionales) usando `ELECTION_JWT_SECRET`.
No confía en las cabeceras `X-User-*`. En desarrollo, `ELECTION_DEV_AUTH=true`
acepta `X-Dev-User` y `X-Dev-Roles` sin token (activado en `docker-compose.yml`).

## Llaves de la urna (FA-09)

| Llave | Tipo | Dónde vive |
| --- | --- | --- |
| Urna (una por elección) | RSA-3072, híbrido `RSA-OAEP-256+A256GCM` | Pública: parámetros y `election.created`. Privada: `urn_keys`, cifrada con AES-256-GCM |
| Maestra (KEK) | 32 bytes | `ELECTION_URN_KEK` o `keys/urn_kek.bin` (volumen `election-keys`) |
| Firma de parámetros | Ed25519 | `keys/parameter_signing.pem` |

- La llave de la urna se genera al **abrir** la elección. El cliente cifra el voto
  así: llave AES-256 aleatoria → AES-GCM sobre la opción → la llave AES se cifra con
  RSA-OAEP-SHA256. Es el formato que descifra Tally
  (`uint16 len || llave_cifrada || nonce(12) || texto_cifrado+tag`, o el JSON equivalente).
- La privada se cifra ligada al `election_id` (dato asociado de AES-GCM): copiar el
  blob a otra elección no sirve.
- **Entrega a Tally:** la vista C&C no tiene conector Tally → Election, así que se
  sigue la opción acordada en el plan: el administrador (CLI/web) pide
  `POST /elections/{id}/urn-key/private` con la urna cerrada y la envía a Tally al
  lanzar el escrutinio (`private_key` en el cuerpo). Cada entrega queda en
  `election_audit` y en `urn_keys.release_count`.
- En producción la KEK debe venir de un gestor de secretos (no del mismo disco que
  la base). Perder la KEK hace imposible descifrar las urnas.

## Ejecutar

```bash
docker compose up --build election          # http://localhost:8001 (ELECTION_PORT)
```

Sin Docker (PostgreSQL y RabbitMQ locales):

```bash
cd election
cp .env.example .env                        # ajustar URLs
psql "$ELECTION_DATABASE_URL" -f schema.sql
uv sync
uv run uvicorn app.main:app --reload --port 8001
```

## Pruebas

```bash
cd election
uv run pytest                               # SQLite en memoria + dobles del broker
# además, contra un PostgreSQL real (base desechable; borra y recrea las tablas):
ELECTION_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/elections_test uv run pytest
```

## Configuración

Ver [`.env.example`](.env.example). Todas las variables usan el prefijo `ELECTION_`
(`DATABASE_URL` también se acepta).

## Integración pendiente con otros servicios

Este servicio ya funciona por sí solo, pero el resto del sistema todavía usa las
elecciones de `identity` (prototipo 1). Para migrar:

| Quién | Cambio |
| --- | --- |
| Cristhian (Gateway) | `GATEWAY_ELECTION_URL=http://election:8000` y rutas nuevas (`PATCH`/`DELETE`, `open`, `urn-key/private`, `GET /elections/{id}`) |
| Andres (Ballot, AN-10) | Registrar la urna a partir de `election.created` y cerrarla con `election.closed`, en lugar del gRPC de identity |
| Kevin (Identity) | Tomar las elecciones de `election.events` para el padrón y retirar `POST /elections` de identity. La llave del token la sigue publicando Identity/Blind Signature |
| Cristhian (Web) | Crear sin `encryption_public_key` (ahora la genera Election), usar `opens_at`/`closes_at` RFC 3339, el botón «Abrir» y verificar la firma con `GET /keys` |
| Julian (CLI) | Comandos crear/abrir/cerrar y obtener la llave privada para Tally |
| Sebastian (RabbitMQ/Tally) | Declarar `election.events` en la definición del broker; Tally recibe la llave privada desde la CLI |
