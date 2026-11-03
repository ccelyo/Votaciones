# Contratos y topología de eventos (SE-02, SE-03)

Responsable: Sebastian. Consumidores actuales: Analytics (Sergio) y
Notifications (Camilo). Productores previstos: Identity (Kevin), Election
(Fabian), Ballot (Andres) y Tally.

Este documento fija el sobre común, los esquemas de `identity.events`,
`election.events`, `votes.events` y `tally.completed`, y la decisión de publicar
ese último en un exchange propio `tally.events`.

## 1. Topología RabbitMQ

Todos los exchanges son `topic` y duraderos. La **routing key siempre es igual a
`event_type`**.

| Exchange | Productor | Consumidores |
| --- | --- | --- |
| `identity.events` | Identity | Analytics, Notifications |
| `election.events` | Election | Analytics, Notifications |
| `votes.events` | Ballot | Analytics, Notifications |
| `tally.events` | **Tally** | Analytics, Notifications |

| Cola | Bindings | DLQ |
| --- | --- | --- |
| `analytics.events` | `election.created`, `election.closed`, `census.updated`, `votes.cast`, `tally.completed` | `analytics.dlx` → `analytics.events.dlq` |
| `notifications.election` | `election.created`, `election.closed` | `notifications.election.dlx` → `notifications.election.dlq` |
| `notifications.identity` | `census.updated` | `notifications.identity.dlx` → `notifications.identity.dlq` |
| `notifications.votes` | `votes.cast` | `notifications.votes.dlx` → `notifications.votes.dlq` |
| `notifications.tally` | `tally.completed` | `notifications.tally.dlx` → `notifications.tally.dlq` |

No existe cola de Tally: **Tally no consume eventos**. Obtiene las papeletas de
Ballot por REST al cerrar la urna.

`rabbitmq/definitions.json` declara exchanges, colas y bindings al arrancar
(`management.load_definitions`). Los servicios también declaran la topología de
forma idempotente, con exactamente las mismas opciones (`topic`, `durable=true`,
y `x-dead-letter-exchange` en las colas), para que el broker funcione aunque no
se monte el archivo.

## 2. Sobre común

```json
{
  "event_id": "0f0d4c1e-6a1d-5b2a-9c3e-2f5a7b8c9d10",
  "event_type": "tally.completed",
  "occurred_at": "2026-11-02T18:00:00Z",
  "producer": "tally",
  "schema_version": 1,
  "data": { }
}
```

| Campo | Tipo | Obligatorio | Regla |
| --- | --- | --- | --- |
| `event_id` | string | sí | Único por evento; se reutiliza en reintentos |
| `event_type` | string | sí | Igual a la routing key |
| `occurred_at` | datetime | sí | RFC 3339 en UTC |
| `producer` | string | no | `identity`, `election`, `ballot`, `tally` |
| `schema_version` | integer | no | `1` (default); otra versión se rechaza |
| `data` | object | sí | Payload del evento |

Publicación: `content_type=application/json`, `delivery_mode=2` (persistente),
`message_id=event_id` y **publisher confirms**. Tally además publica con
`mandatory=true`: si no hay ninguna cola enlazada, el evento se considera no
entregado y se reintenta.

## 3. `identity.events`

### `census.updated`

| Campo | Tipo | Obligatorio |
| --- | --- | --- |
| `election_id` | string | sí |
| `eligible_voters` | integer | sí |

Analytics lo usa para calcular participación y abstención.

### `identity.credential.issued`

Evento previsto en la vista C&C para la emisión de credenciales. Debe contener
solo datos agregados o seudónimos:

| Campo | Tipo | Obligatorio |
| --- | --- | --- |
| `election_id` | string | sí |
| `issued_at` | datetime | sí |
| `credential_kind` | string | no |

**Nunca** debe incluir `user_id`, documento, token ciego ni firma. Ningún
consumidor lo procesa todavía; Kevin debe confirmar el payload antes de
publicarlo (SE-07).

## 4. `election.events`

### `election.created`

| Campo | Tipo | Obligatorio |
| --- | --- | --- |
| `election_id` | string | sí |
| `name` | string | no |
| `options` | string[] | sí (no vacío) |
| `blank_option` | string | no (debe estar en `options`) |
| `opens_at`, `closes_at` | datetime | sí (`closes_at > opens_at`) |

### `election.opened`

| Campo | Tipo | Obligatorio |
| --- | --- | --- |
| `election_id` | string | sí |
| `opened_at` | datetime | sí |

Previsto en la vista; ningún consumidor lo procesa todavía.

### `election.closed`

| Campo | Tipo | Obligatorio |
| --- | --- | --- |
| `election_id` | string | sí |
| `closed_at` | datetime | sí |

Analytics lo usa como cierre oficial si `tally.completed` no lo trae.

## 5. `votes.events`

### `votes.cast`

| Campo | Tipo | Obligatorio |
| --- | --- | --- |
| `election_id` | string | sí |
| `cast_at` | datetime | sí |

Solo permite calcular participación por hora. **Nunca** incluye token, recibo,
`ballot_hash` ni ningún dato que permita enlazar el voto con el votante.

### `tally.completed`

**No se publica en `votes.events`.** Ver la decisión de la sección 6.

## 6. `tally.events` — `tally.completed`

Decisión SE-03: `tally.completed` viaja **solo** por el exchange `tally.events`,
con routing key `tally.completed`. Motivos:

- Separa el dominio «voto emitido» (`votes.events`) del «escrutinio oficial».
- Deja claro qué componente es el productor: solo Tally.
- Analytics y Notifications ya escuchan en `tally.events`; mantener también el
  binding en `votes.events` es solo compatibilidad y no obliga a publicar dos
  veces.

```json
{
  "event_id": "0f0d4c1e-6a1d-5b2a-9c3e-2f5a7b8c9d10",
  "event_type": "tally.completed",
  "occurred_at": "2026-11-02T18:00:00Z",
  "producer": "tally",
  "schema_version": 1,
  "data": {
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
    "ballots_digest": "9f2c…"
  }
}
```

| Campo | Tipo | Obligatorio | Regla |
| --- | --- | --- | --- |
| `election_id` | string | sí | |
| `total_ballots` | integer | sí | `sum(results.votes) + invalid_ballots == total_ballots` |
| `invalid_ballots` | integer | sí | Papeletas nulas |
| `results` | `{option, votes}[]` | sí | Orden de las opciones de la elección; el blanco es válido |
| `tallied_at` | datetime | sí | Instante del escrutinio |
| `ballots_digest` | string | no | SHA-256 hex de `election_id`, las opciones y las papeletas ordenadas |

Es el **resultado oficial**. Ballot puede seguir calculando un agregado con su
endpoint `/results`, pero la fuente oficial del conteo es este evento y su
persistencia en Analytics.

### Idempotencia

`event_id` es un UUIDv5 determinista de
`"tally.completed|v1|" + election_id + "|" + ballots_digest`, donde el digest es
SHA-256 de `election_id`, las opciones y las papeletas ordenadas. Consecuencias:

- Relanzar el escrutinio sobre la misma urna reutiliza el `event_id`.
- Analytics descarta duplicados por `event_id` (`processed_events`).
- Notifications tiene índice único en `eventId`, así que tampoco duplica avisos.
- Un recuento con papeletas distintas genera otro `event_id`; Analytics
  **reemplaza** el conteo anterior de esa elección (no lo suma).

## 7. Entregas, reintentos y errores

| Situación | Comportamiento |
| --- | --- |
| RabbitMQ caído al publicar | Tally reintenta 5 veces con backoff 200 ms…3,2 s; luego `503 broker_unavailable` |
| Evento sin cola enlazada | `mandatory=true` lo devuelve; Tally lo trata como fallo y reintenta |
| Consumidor caído | La cola es duradera y el mensaje persistente; se entrega al reconectar |
| Mensaje mal formado o tipo desconocido | El consumidor hace `nack` sin reencolar → DLQ del consumidor |
| Fallo transitorio del consumidor (Mongo, etc.) | Reencola con pausa y backoff; Analytics libera el `event_id` |
| Entrega repetida | Analytics y Notifications deduplican por `event_id` |
| Orden | No se garantiza entre eventos distintos; cada consumidor es idempotente y tolera cualquier orden |

## 8. Versionado

Cualquier cambio incompatible (renombrar o quitar campos, cambiar semántica)
requiere `schema_version: 2` y coordinar a todos los consumidores. Añadir campos
opcionales, como `ballots_digest`, no cambia la versión: los consumidores ignoran
los campos desconocidos.
