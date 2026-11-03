# Tally (Go)

Servicio de escrutinio del Prototipo 2 (sección 3.6 de
`docs/plan-prototipos/02-Prototype.md`, actividades SE-04 a SE-10).

Tally **lee las papeletas cifradas de Ballot por REST**, las descifra, aplica las
reglas de conteo, publica `tally.completed` en RabbitMQ y expone el último
resultado por HTTP. No se suscribe al broker y **no tiene base de datos propia**:
Ballot (colección `ballots`, a la que la vista C&C llama «Votes») es la fuente de
verdad de las papeletas y Analytics persiste el conteo oficial que publica Tally.

Contratos de eventos y topología completa: [docs/events.md](docs/events.md).

## Flujo

```
Admin/CLI ──POST /v1/tally/elections/{id}──▶ Tally
                                             │ GET /v1/elections/{id}/parameters
                                             │ GET /v1/elections/{id}/ballots
                                             ▼
                                           Ballot (MongoDB)
                                             │ papeletas cifradas
                                             ▼
                                           descifrar + contar
                                             │ tally.completed
                                             ▼
                                     RabbitMQ (tally.events)
                                        │             │
                                        ▼             ▼
                                    Analytics    Notifications
```

## API

| Método | Ruta | Rol en el Gateway | Descripción |
| --- | --- | --- | --- |
| `POST` | `/v1/tally/elections/{electionID}` | admin | Lanza el escrutinio |
| `GET` | `/v1/tally/elections/{electionID}` | user | Último conteo de este proceso |
| `GET` | `/healthz` | — | Liveness |
| `GET` | `/readyz` | — | Ballot + RabbitMQ alcanzables |

El API Gateway valida el JWT; Tally no autentica por sí mismo y no debe
publicarse directamente a Internet.

### Lanzar el escrutinio

```bash
curl -X POST http://localhost:8088/api/tally/elections/consejo-superior-2026 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"private_key\": \"$(cat urna.pem)\"}"
```

El cuerpo es opcional. Si no se envía `private_key`, Tally usa
`TALLY_PRIVATE_KEY` o `TALLY_PRIVATE_KEY_FILE`.

El `POST` es síncrono y tiene un límite interno de 60 s. El API Gateway debe
permitir más que eso (`GATEWAY_UPSTREAM_TIMEOUT_MS`; `docker-compose.yml` usa
70 s). Si el Gateway corta la respuesta, el escrutinio sigue en Tally y publica
el evento; se puede consultar con `GET` o relanzar, que es idempotente.

```json
{
  "election_id": "consejo-superior-2026",
  "total_ballots": 950,
  "invalid_ballots": 18,
  "results": [
    { "option": "candidata-1", "votes": 412 },
    { "option": "candidato-2", "votes": 365 },
    { "option": "candidato-3", "votes": 98 },
    { "option": "voto-en-blanco", "votes": 57 }
  ],
  "tallied_at": "2026-11-02T18:00:00Z",
  "event_id": "0f0d…",
  "reused": false
}
```

Errores: `{"error": "<código>"}`.

| Código | `error` | Causa |
| --- | --- | --- |
| 400 | `invalid_election_id` | ID vacío o con `/?#` |
| 400 | `invalid_request` | JSON inválido o campo desconocido |
| 400 | `invalid_private_key` | La clave no es RSA o no corresponde a la urna |
| 400 | `urn_key_required` | Hay papeletas cifradas y no se envió clave |
| 400 | `all_ballots_undecryptable` | Ninguna papeleta se pudo abrir: probable clave equivocada |
| 404 | `election_not_found` | Ballot no conoce la elección |
| 404 | `tally_pending` | Aún no hay conteo en este proceso |
| 409 | `election_not_closed` | La urna sigue abierta |
| 422 | `invalid_election_options` | Opciones vacías, repetidas o con espacios |
| 502 | `ballot_unavailable` | Ballot no responde o rechaza el token interno |
| 503 | `broker_unavailable` | RabbitMQ no confirma la publicación |
| 504 | `upstream_timeout` | El escrutinio excedió 60 s |

## Decisión: entrega de la llave privada

La vista C&C no tiene un conector Tally → Election. Para no inventar uno y no
guardar la clave en Tally, el prototipo adopta la segunda opción que dejó
abierta el plan: **la clave viaja con el lanzamiento del escrutinio**.

1. La CLI/UI de administración envía `private_key` en el `POST`.
2. Alternativa para automatización: `TALLY_PRIVATE_KEY` o
   `TALLY_PRIVATE_KEY_FILE` en el contenedor.
3. Tally compara la clave con `encryption_public_key` de los parámetros de
   Ballot. Si ambas son RSA parseables y no coinciden, rechaza el escrutinio
   con `invalid_private_key` antes de contar.
4. La clave nunca se registra ni se persiste; vive en memoria durante la
   petición.

Pendiente con Fabian: si más adelante se prefiere un conector REST
`Tally → Election`, basta cambiar la fuente de la clave en `RunRequest`; el
conteo y los eventos no cambian.

## Idempotencia del escrutinio

- El `event_id` es un **UUIDv5 determinista** de
  `electionID + SHA-256(opciones + papeletas ordenadas)`.
- Volver a lanzar el escrutinio sobre la misma urna devuelve el resultado
  cacheado sin republicar (`reused: true`).
- Tras un reinicio, el caché se pierde, pero el `event_id` vuelve a ser el
  mismo: Analytics lo descarta como duplicado y no cuenta dos veces.
- Un recuento con papeletas distintas produce otro `event_id`; Analytics
  **reemplaza** el conteo anterior de esa elección.
- `"republish": true` reenvía el mismo evento (mismo `event_id`) sin recalcular.

El caché es solo memoria: no sustituye la persistencia oficial de Analytics.

## Conteo y descifrado

Reglas (`internal/count`):

- Válido: el contenido descifrado coincide **exactamente** con una opción.
- El voto en blanco es una opción más si aparece en `options`.
- Inválido: descifrado fallido, opción desconocida, vacío o texto con caracteres
  de control.
- `sum(resultados) + inválidos == total`, invariante que Analytics también valida.
- Si **todas** las papeletas fallan al descifrar, el escrutinio se aborta para no
  publicar un cero falso.

Formatos (`internal/decrypt`):

| Formato | Estado | Descripción |
| --- | --- | --- |
| Texto plano | Compatibilidad P1 | El «ciphertext» es la opción en UTF-8. Se desactiva con `TALLY_ALLOW_PLAINTEXT=false` |
| Híbrido RSA-OAEP-256 + AES-256-GCM | Soportado | Sobre JSON o binario; ver el paquete `decrypt` |

Sobre híbrido JSON:

```json
{
  "alg": "RSA-OAEP-256+A256GCM",
  "key": "<base64url de la llave AES cifrada con RSA-OAEP>",
  "nonce": "<base64url de 12 bytes>",
  "ciphertext": "<base64url de AES-GCM>"
}
```

Sobre híbrido binario: `uint16 key_len` (big endian) ‖ llave envuelta ‖ nonce(12)
‖ AES-GCM.

> El plan P1 definió el cifrado híbrido RSA-OAEP + AES-GCM y la urna ya publica
> una `encryption_public_key` RSA; este prototipo implementa ese sobre. ElGamal
> homomórfico queda fuera de alcance hasta que el cliente web lo emita y se
> acuerde el formato de la llave.

> El cliente web aún usa el cifrador de texto plano de P1
> (`platform/lib/m4/encryptor.ts`). Cuando se implemente el cifrador real, debe
> emitir uno de estos dos sobres para que Tally lo abra con la clave de la urna.

## Variables de entorno

| Variable | Default | Descripción |
| --- | --- | --- |
| `TALLY_HTTP_ADDR` | `:8092` | Escucha HTTP |
| `BALLOT_URL` | `http://localhost:8080` | Base REST de Ballot |
| `TALLY_BALLOT_TOKEN` | vacío | Bearer compartido con `BALLOT_TALLY_TOKEN` |
| `TALLY_RABBITMQ_URI` / `RABBITMQ_URI` | `amqp://guest:guest@localhost:5672/` | Broker |
| `TALLY_EXCHANGE` | `tally.events` | Exchange topic de salida |
| `TALLY_PRIVATE_KEY` | vacío | Clave RSA por defecto (PEM, DER o base64) |
| `TALLY_PRIVATE_KEY_FILE` | vacío | Archivo con la clave |
| `TALLY_ALLOW_PLAINTEXT` | `true` | Acepta papeletas P1 en claro |
| `TALLY_HTTP_TIMEOUT` | `30s` | Timeout de las llamadas a Ballot |
| `TALLY_PUBLISH_ATTEMPTS` | `5` | Intentos de publicación con confirms |
| `TALLY_HEALTHCHECK_URL` | `http://127.0.0.1:8092/healthz` | Destino de `tally -healthcheck` para Docker |

> `TALLY_PRIVATE_KEY` queda visible en el entorno del contenedor (`docker
> inspect`). Para producción se prefiere el `POST` o un secreto montado en
> `TALLY_PRIVATE_KEY_FILE`, y retirarlo al terminar el escrutinio.

## Desarrollo

Sin Docker (requiere Ballot y RabbitMQ locales):

```bash
go run .
go test ./...
TALLY_TEST_RABBITMQ_URI=amqp://guest:guest@localhost:5672/ go test -tags integration ./...
```

Con Docker, desde la raíz:

```bash
docker compose up --build
# No publica puerto: se entra por el Gateway.
curl -X POST http://localhost:8088/api/tally/elections/<id> \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

Con `go run .`, el healthcheck local es `curl localhost:8092/healthz`.

| Módulo | Responsabilidad |
| --- | --- |
| `internal/config` | Variables de entorno y valores por defecto |
| `internal/ballotclient` | REST Tally → Ballot con reintentos y token interno |
| `internal/decrypt` | Clave de urna y descifrado de papeletas |
| `internal/count` | Reglas de conteo, validaciones y digest determinista |
| `internal/events` | Sobre y `tally.completed`, UUIDv5 determinista |
| `internal/publisher` | Publicación AMQP con confirms, reintentos y reconexión |
| `internal/tally` | Orquestación, caché en memoria e idempotencia |
| `internal/httpapi` | API HTTP interna |
