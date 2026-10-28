# Contratos del servicio Analytics

**Responsable:** Sergio · **Tecnologías:** Rust (axum, lapin, mongodb) · **Base:** MongoDB «Results»

Analytics procesa los eventos de una elección y, cuando la elección **ya terminó** y
tally publicó el conteo final, guarda un informe analítico completo en su propia base
MongoDB y lo expone por REST/JSON a través del API Gateway.

Alineado con `docs/plan-prototipos/02-Prototype.md` (sección 3.8 y riesgo 10.6): **Tally es
la fuente de verdad del conteo oficial**; Analytics calcula la **participación en tiempo
real** a partir de `votes.cast` y almacena en Results los resultados finales recibidos en
`tally.completed`, junto con las métricas derivadas.

```
election.events ─┐
identity.events ─┤
votes.events ────┼─► RabbitMQ ──► cola analytics.events ──► Analytics (Rust) ──► MongoDB «Results»
tally.events ────┘                       │                          │
                                         └─► analytics.events.dlq   └─► GET /v1/analytics/... (vía API Gateway)
```

Analytics solo **consume** eventos; no publica ninguno ni llama a otros servicios.

Además de la API REST, el servicio sirve un **panel web** en `/dashboard` (sección 7), con
acceso por correo y contraseña, que muestra todas las analíticas con gráficas.

Garantías de privacidad: ningún evento ni colección de analytics contiene tokens, recibos,
identificadores de votante ni el voto individual. La participación se guarda agregada por
hora. Con la urna abierta solo se expone el número de papeletas recibidas (sin la hora en
curso, ver 4.5); resultados y métricas por opción solo existen tras `tally.completed`.

---

## 1. Topología RabbitMQ

| Recurso | Tipo | Opciones | Declara |
| --- | --- | --- | --- |
| `election.events` | exchange `topic` | durable | analytics (idempotente) y Election |
| `identity.events` | exchange `topic` | durable | analytics (idempotente) e Identity |
| `votes.events` | exchange `topic` | durable | analytics (idempotente), Ballot y Tally |
| `tally.events` | exchange `topic` | durable | analytics (idempotente); Tally si lo elige |
| `analytics.events` | cola | durable, `x-dead-letter-exchange=analytics.dlx` | analytics |
| `analytics.dlx` | exchange `fanout` | durable | analytics |
| `analytics.events.dlq` | cola | durable | analytics |

Bindings de `analytics.events`:

| Exchange | Routing key | Productor |
| --- | --- | --- |
| `election.events` | `election.created` | Election (Fabian) |
| `election.events` | `election.closed` | Election (Fabian) |
| `identity.events` | `census.updated` | Identity (Kevin) |
| `votes.events` | `votes.cast` | Ballot (Andres) |
| `votes.events` | `tally.completed` | Tally (Sebastian) |
| `tally.events` | `tally.completed` | Tally (Sebastian) |

> El plan P2 (SE-03) deja abierto si `tally.completed` va en `votes.events` o en un
> exchange `tally.events`. Analytics escucha en ambos, así que funciona con cualquiera de
> las dos decisiones; Tally debe publicar en **uno solo** (si publica en los dos, el mismo
> `event_id` se descarta como duplicado, pero no es necesario).

> Quien declare los mismos exchanges debe usar **exactamente** `topic` + `durable=true`;
> si no, RabbitMQ rechaza la declaración con `PRECONDITION_FAILED`.

### Requisitos para los productores

- Publicar con `content_type=application/json` y `delivery_mode=2` (persistente).
- La **routing key es igual a `event_type`**.
- `event_id` único por evento (UUID v4 recomendado). Si se reintenta la publicación, se
  reutiliza el mismo `event_id`: analytics descarta los duplicados.
- Fechas en RFC 3339 / ISO 8601 con zona (`2026-10-20T21:00:00Z`).
- Se recomienda usar *publisher confirms*.

---

## 2. Sobre común de los eventos

```json
{
  "event_id": "2f6b1c1e-3f7a-4d0c-9a51-5b2e0d0f6a10",
  "event_type": "tally.completed",
  "occurred_at": "2026-10-20T21:02:01Z",
  "producer": "tally",
  "schema_version": 1,
  "data": { }
}
```

| Campo | Tipo | Obligatorio | Nota |
| --- | --- | --- | --- |
| `event_id` | string | sí | Clave de idempotencia |
| `event_type` | string | sí | Uno de los de la sección 3; igual a la routing key |
| `occurred_at` | datetime | sí | Momento en que ocurrió el hecho |
| `producer` | string | no | `election`, `identity`, `ballot`, `tally` |
| `schema_version` | integer | no (defecto `1`) | Cualquier otro valor va a la DLQ |
| `data` | object | sí | Contenido específico del evento |

---

## 3. Eventos consumidos

### 3.1 `election.created` — Election → `election.events`

Se publica cuando se crea (o configura) una elección.

```json
{
  "election_id": "consejo-superior-2026",
  "name": "Consejo Superior Universitario 2026",
  "options": ["candidata-1", "candidato-2", "candidato-3", "voto-en-blanco"],
  "blank_option": "voto-en-blanco",
  "opens_at": "2026-10-20T13:00:00Z",
  "closes_at": "2026-10-20T21:00:00Z"
}
```

| Campo | Tipo | Obligatorio | Regla |
| --- | --- | --- | --- |
| `election_id` | string | sí | No vacío. Mismo id que usa ballot |
| `name` | string | no | Nombre visible |
| `options` | string[] | sí | No vacío. Mismos textos que en ballot; define el orden en empates |
| `blank_option` | string | no | Debe estar en `options`. Habilita las métricas de voto en blanco |
| `opens_at` | datetime | sí | |
| `closes_at` | datetime | sí | Posterior a `opens_at` |

Volver a publicarlo con otro `event_id` actualiza los metadatos (no borra `closed_at` ni el censo).

### 3.2 `election.closed` — Election → `election.events`

```json
{ "election_id": "consejo-superior-2026", "closed_at": "2026-10-20T21:00:00Z" }
```

| Campo | Tipo | Obligatorio |
| --- | --- | --- |
| `election_id` | string | sí |
| `closed_at` | datetime | sí |

### 3.3 `census.updated` — Identity → `identity.events`

Número de votantes habilitados en el censo de una elección. Necesario para participación
y abstención; si nunca llega, esas métricas salen `null`.

```json
{ "election_id": "consejo-superior-2026", "eligible_voters": 1500 }
```

| Campo | Tipo | Obligatorio | Regla |
| --- | --- | --- | --- |
| `election_id` | string | sí | |
| `eligible_voters` | integer ≥ 0 | sí | Total, no incremento. El último recibido prevalece |

### 3.4 `votes.cast` — Ballot → `votes.events`

Una papeleta aceptada. **Solo** la elección y el instante: nunca token, recibo, `seq`,
voto ni datos del votante. Se recomienda que ballot trunque `cast_at` al minuto (riesgo
10.4 del plan P2: evitar la correlación temporal con `identity.credential.issued`).

```json
{ "election_id": "consejo-superior-2026", "cast_at": "2026-10-20T15:42:00Z" }
```

| Campo | Tipo | Obligatorio |
| --- | --- | --- |
| `election_id` | string | sí |
| `cast_at` | datetime | sí |

Analytics solo suma 1 en el contador de esa hora (`turnout_hourly`). Con estos contadores
calcula la participación en tiempo real (4.5) y la línea de tiempo del informe final.

### 3.5 `tally.completed` — Tally → `votes.events` o `tally.events`

Conteo final de una elección cerrada. Mismo formato que
`GET /v1/elections/{election_id}/results` de ballot, más `tallied_at`. **Es el evento que
genera el informe**: sin él no hay analíticas de la elección.

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
  "tallied_at": "2026-10-20T21:02:00Z"
}
```

| Campo | Tipo | Obligatorio | Regla |
| --- | --- | --- | --- |
| `election_id` | string | sí | |
| `total_ballots` | integer | sí | `sum(results.votes) + invalid_ballots == total_ballots` |
| `invalid_ballots` | integer | sí | Papeletas nulas |
| `results` | `{option, votes}[]` | sí | Votos válidos por opción (el blanco cuenta como válido) |
| `tallied_at` | datetime | sí | Si no llegó `election.closed`, se usa como `closed_at` |

Un nuevo `tally.completed` (recuento) reemplaza el anterior y regenera el informe.

### 3.6 Orden, duplicados y errores

| Situación | Comportamiento |
| --- | --- |
| Eventos en cualquier orden | Se acepta. Cada evento actualiza su parte y, si ya hay conteo, el informe se recalcula |
| `event_id` repetido | `ack` sin aplicarlo de nuevo (colección `processed_events`) |
| JSON inválido, `event_type` desconocido, `schema_version ≠ 1`, campos faltantes o conteo inconsistente | `nack` sin reencolar → `analytics.events.dlq` |
| MongoDB no disponible | Se libera el `event_id` y se reencola tras 1 s |
| RabbitMQ caído | Reconexión con backoff exponencial (1 s … 30 s); `/readyz` responde 503 mientras tanto |

---

## 4. API HTTP (REST/JSON)

Puerto por defecto `8090`. Pensada para consumirse a través del **API Gateway**, que valida
el JWT; analytics no autentica por sí mismo.

Convenciones:

- Proporciones como fracción `0..1` redondeada a 4 decimales (`0.6333` = 63,33 %).
- `margin_points` en puntos porcentuales (`0..100`).
- Fechas en UTC, RFC 3339.
- Campos que dependen de datos opcionales (censo, `blank_option`) valen `null` si faltan.
- Errores: `{ "error": "<código>" }`.

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness (MongoDB + consumidor RabbitMQ) |
| GET | `/v1/analytics/summary` | Agregado de todas las elecciones con informe |
| GET | `/v1/analytics/elections` | Listado paginado de elecciones con informe |
| GET | `/v1/analytics/elections/{election_id}` | Informe completo |
| GET | `/v1/analytics/elections/{election_id}/results` | Resultados por opción |
| GET | `/v1/analytics/elections/{election_id}/participation` | Participación en tiempo real (también con la urna abierta) |
| GET | `/v1/analytics/elections/{election_id}/turnout` | Participación y línea de tiempo |
| POST | `/v1/analytics/elections/{election_id}/recompute` | Recalcula el informe (solo admin, en el Gateway) |

### Errores comunes a `/v1/analytics/elections/{election_id}[/…]`

(Excepto `/participation`, que solo responde 404 y 503: ver 4.5.)

| Código | `error` | Cuándo |
| --- | --- | --- |
| 404 | `election_not_found` | Analytics no ha recibido ningún evento de la elección |
| 409 | `election_not_closed` | La elección existe pero aún no cierra: no se exponen datos parciales |
| 409 | `tally_pending` | Ya cerró, pero todavía no llega `tally.completed` |
| 503 | `storage_unavailable` | MongoDB no responde |

### 4.1 `GET /healthz`

`200` → `{ "status": "ok" }`

### 4.2 `GET /readyz`

`200` si MongoDB responde y el consumidor está conectado; si no, `503`.

```json
{ "mongodb": true, "rabbitmq": true }
```

### 4.3 `GET /v1/analytics/elections/{election_id}`

Informe completo. `200`:

```json
{
  "election_id": "consejo-superior-2026",
  "name": "Consejo Superior Universitario 2026",
  "status": "final",
  "schedule": {
    "opens_at": "2026-10-20T13:00:00Z",
    "closes_at": "2026-10-20T21:00:00Z",
    "closed_at": "2026-10-20T21:00:00Z",
    "duration_hours": 8.0
  },
  "totals": {
    "eligible_voters": 1500,
    "total_ballots": 950,
    "valid_ballots": 932,
    "invalid_ballots": 18,
    "blank_ballots": 57,
    "abstentions": 550
  },
  "rates": {
    "turnout": 0.6333,
    "abstention": 0.3667,
    "valid": 0.9811,
    "invalid": 0.0189,
    "blank": 0.0612
  },
  "results": [
    { "option": "candidata-1", "votes": 412, "rank": 1, "share_of_valid": 0.4421, "share_of_total": 0.4337, "is_blank": false },
    { "option": "candidato-2", "votes": 365, "rank": 2, "share_of_valid": 0.3916, "share_of_total": 0.3842, "is_blank": false },
    { "option": "candidato-3", "votes": 98, "rank": 3, "share_of_valid": 0.1052, "share_of_total": 0.1032, "is_blank": false },
    { "option": "voto-en-blanco", "votes": 57, "rank": 4, "share_of_valid": 0.0612, "share_of_total": 0.06, "is_blank": true }
  ],
  "outcome": {
    "winner": "candidata-1",
    "winner_votes": 412,
    "tie": false,
    "tied_options": [],
    "runner_up": "candidato-2",
    "margin_votes": 47,
    "margin_points": 5.0429,
    "blank_won": false
  },
  "competitiveness": {
    "options_with_votes": 4,
    "herfindahl_index": 0.3636,
    "effective_number_of_options": 2.7504
  },
  "participation": {
    "bucket": "hour",
    "recorded_ballots": 950,
    "matches_tally": true,
    "first_ballot_at": "2026-10-20T13:00:00Z",
    "last_ballot_at": "2026-10-20T21:00:00Z",
    "peak": { "start": "2026-10-20T15:00:00Z", "ballots": 162, "cumulative": 324, "cumulative_turnout": 0.216 },
    "by_hour_of_day_utc": [0,0,0,0,0,0,0,0,0,0,0,0,0,57,105,162,133,86,114,152,141,0,0,0],
    "timeline": [
      { "start": "2026-10-20T13:00:00Z", "ballots": 57, "cumulative": 57, "cumulative_turnout": 0.038 },
      { "start": "2026-10-20T14:00:00Z", "ballots": 105, "cumulative": 162, "cumulative_turnout": 0.108 },
      { "start": "2026-10-20T15:00:00Z", "ballots": 162, "cumulative": 324, "cumulative_turnout": 0.216 },
      { "start": "2026-10-20T16:00:00Z", "ballots": 133, "cumulative": 457, "cumulative_turnout": 0.3047 },
      { "start": "2026-10-20T17:00:00Z", "ballots": 86, "cumulative": 543, "cumulative_turnout": 0.362 },
      { "start": "2026-10-20T18:00:00Z", "ballots": 114, "cumulative": 657, "cumulative_turnout": 0.438 },
      { "start": "2026-10-20T19:00:00Z", "ballots": 152, "cumulative": 809, "cumulative_turnout": 0.5393 },
      { "start": "2026-10-20T20:00:00Z", "ballots": 141, "cumulative": 950, "cumulative_turnout": 0.6333 }
    ]
  },
  "tallied_at": "2026-10-20T21:02:00Z",
  "generated_at": "2026-10-20T21:03:00Z"
}
```

#### Definición de las métricas

| Campo | Fórmula / significado |
| --- | --- |
| `schedule.duration_hours` | `(closed_at ?? closes_at) − opens_at` en horas |
| `totals.valid_ballots` | `total_ballots − invalid_ballots` (incluye blanco) |
| `totals.blank_ballots` | Votos de `blank_option`; `null` si no se definió |
| `totals.abstentions` | `eligible_voters − total_ballots`; `null` sin censo |
| `rates.turnout` | `total_ballots / eligible_voters` |
| `rates.abstention` | `abstentions / eligible_voters` |
| `rates.valid` / `rates.invalid` | Sobre `total_ballots` |
| `rates.blank` | `blank_ballots / valid_ballots` |
| `results[]` | Ordenado por votos desc.; en empate, el orden de `options` |
| `results[].rank` | Ranking de competición: empatados comparten puesto (1, 1, 3) |
| `results[].share_of_valid` | `votes / valid_ballots` |
| `results[].share_of_total` | `votes / total_ballots` |
| `outcome.winner` | Opción con más votos; `null` si hay empate en el primer puesto o 0 votos válidos |
| `outcome.tie` / `tied_options` | Empate en el primer puesto y las opciones empatadas |
| `outcome.runner_up` | Segunda opción; `null` si hay empate |
| `outcome.margin_votes` / `margin_points` | 1.º − 2.º, en votos y en puntos porcentuales de los válidos |
| `outcome.blank_won` | El ganador es `blank_option` |
| `competitiveness.herfindahl_index` | `Σ share_of_valid²` (1 = una sola opción concentra todo) |
| `competitiveness.effective_number_of_options` | `1 / herfindahl_index` (Laakso–Taagepera) |
| `participation.recorded_ballots` | Suma de los `votes.cast` recibidos |
| `participation.matches_tally` | `recorded_ballots == total_ballots`; `false` indica eventos `votes.cast` perdidos |
| `participation.first_ballot_at` / `last_ballot_at` | Inicio de la primera hora con votos / fin de la última |
| `participation.peak` | Hora con más papeletas (la primera si hay empate) |
| `participation.by_hour_of_day_utc` | 24 posiciones: papeletas por hora del día (UTC) |
| `participation.timeline[]` | Por hora: papeletas, acumulado y participación acumulada |

### 4.4 `GET /v1/analytics/elections/{election_id}/results`

`200`:

```json
{
  "election_id": "consejo-superior-2026",
  "total_ballots": 950,
  "valid_ballots": 932,
  "invalid_ballots": 18,
  "blank_ballots": 57,
  "winner": "candidata-1",
  "tie": false,
  "results": [
    { "option": "candidata-1", "votes": 412, "rank": 1, "share_of_valid": 0.4421, "share_of_total": 0.4337, "is_blank": false }
  ]
}
```

(`results` contiene todas las opciones; se recorta aquí por brevedad.)

### 4.5 `GET /v1/analytics/elections/{election_id}/participation`

Participación en tiempo real a partir de `votes.cast`. A diferencia del resto de rutas por
elección, **responde también con la urna abierta**, pero nunca incluye resultados por opción.

- Mientras `status` es `open` o `scheduled`, `timeline` **omite la hora en curso**: solo
  muestra horas completas, para que el contador no avance voto a voto. `ballots_received`
  sí es el total al momento.
- Con `status` `closed` o `final`, `timeline` incluye todas las horas.

`200` (urna abierta, consultada a las 15:30 UTC):

```json
{
  "election_id": "consejo-superior-2026",
  "name": "Consejo Superior Universitario 2026",
  "status": "open",
  "opens_at": "2026-10-20T13:00:00Z",
  "closes_at": "2026-10-20T21:00:00Z",
  "closed_at": null,
  "eligible_voters": 1500,
  "ballots_received": 350,
  "turnout": 0.2333,
  "timeline": [
    { "start": "2026-10-20T13:00:00Z", "ballots": 57, "cumulative": 57, "cumulative_turnout": 0.038 },
    { "start": "2026-10-20T14:00:00Z", "ballots": 105, "cumulative": 162, "cumulative_turnout": 0.108 }
  ],
  "as_of": "2026-10-20T15:30:00Z"
}
```

| `status` | Significado |
| --- | --- |
| `scheduled` | Aún no abre (`now < opens_at`) |
| `open` | Abierta |
| `closed` | Cerró (`election.closed` o pasó `closes_at`); conteo pendiente |
| `final` | Ya llegó `tally.completed`; el informe completo está en 4.3 |
| `unknown` | Llegaron `votes.cast` pero no `election.created` |

| Código | `error` | Cuándo |
| --- | --- | --- |
| 404 | `election_not_found` | Ni metadatos ni votos de esa elección |
| 503 | `storage_unavailable` | MongoDB no responde |

### 4.6 `GET /v1/analytics/elections/{election_id}/turnout?bucket=hour|day`

| Parámetro | Defecto | Valores |
| --- | --- | --- |
| `bucket` | `hour` | `hour`, `day` (UTC). Otro valor → `400 invalid_bucket` |

`200`:

```json
{
  "election_id": "consejo-superior-2026",
  "bucket": "day",
  "eligible_voters": 1500,
  "total_ballots": 950,
  "turnout": 0.6333,
  "abstention": 0.3667,
  "recorded_ballots": 950,
  "matches_tally": true,
  "peak": { "start": "2026-10-20T00:00:00Z", "ballots": 950, "cumulative": 950, "cumulative_turnout": 0.6333 },
  "by_hour_of_day_utc": [0,0,0,0,0,0,0,0,0,0,0,0,0,57,105,162,133,86,114,152,141,0,0,0],
  "timeline": [
    { "start": "2026-10-20T00:00:00Z", "ballots": 950, "cumulative": 950, "cumulative_turnout": 0.6333 }
  ]
}
```

### 4.7 `GET /v1/analytics/elections?limit=20&offset=0`

Elecciones con informe, de la más reciente (`tallied_at`) a la más antigua.

| Parámetro | Defecto | Regla |
| --- | --- | --- |
| `limit` | `20` | `1..100`; fuera de rango → `400 invalid_limit` |
| `offset` | `0` | |

`200`:

```json
{
  "total": 1,
  "limit": 20,
  "offset": 0,
  "items": [
    {
      "election_id": "consejo-superior-2026",
      "name": "Consejo Superior Universitario 2026",
      "closed_at": "2026-10-20T21:00:00Z",
      "total_ballots": 950,
      "turnout": 0.6333,
      "winner": "candidata-1",
      "tie": false,
      "margin_points": 5.0429
    }
  ]
}
```

### 4.8 `GET /v1/analytics/summary`

Agregado de todas las elecciones con informe. `200`:

```json
{
  "elections": 1,
  "total_ballots": 950,
  "valid_ballots": 932,
  "invalid_ballots": 18,
  "eligible_voters": 1500,
  "average_turnout": 0.6333,
  "weighted_turnout": 0.6333,
  "average_invalid_rate": 0.0189,
  "ties": 0,
  "highest_turnout": { "election_id": "consejo-superior-2026", "value": 0.6333 },
  "lowest_turnout": { "election_id": "consejo-superior-2026", "value": 0.6333 },
  "closest_race": { "election_id": "consejo-superior-2026", "value": 5.0429 },
  "largest_election": { "election_id": "consejo-superior-2026", "value": 950.0 },
  "generated_at": "2026-10-20T22:00:00Z"
}
```

| Campo | Significado |
| --- | --- |
| `average_turnout` | Media simple de `rates.turnout` (solo elecciones con censo) |
| `weighted_turnout` | `Σ total_ballots / Σ eligible_voters` (solo elecciones con censo) |
| `average_invalid_rate` | Media de `rates.invalid` (elecciones con al menos una papeleta) |
| `closest_race.value` | Menor `margin_points` |
| `largest_election.value` | Mayor `total_ballots` |

Con cero elecciones, los campos agregados opcionales valen `null`.

### 4.9 `POST /v1/analytics/elections/{election_id}/recompute`

Recalcula el informe con lo que hay en la base (sin cuerpo). `200` con el informe de 4.3,
o los mismos errores 404/409. El Gateway debe restringirlo a administradores.

---

## 5. MongoDB «Results»

Base `ANALYTICS_MONGODB_DATABASE` (defecto `results`), exclusiva de analytics. No requiere
replica set.

| Colección | `_id` | Contenido | Índices |
| --- | --- | --- | --- |
| `elections` | `election_id` | `name`, `options`, `blank_option`, `opens_at`, `closes_at`, `closed_at`, `eligible_voters` | — |
| `tallies` | `election_id` | `total_ballots`, `invalid_ballots`, `results[]`, `tallied_at`, `event_id` | — |
| `turnout_hourly` | ObjectId | `election_id`, `hour` (inicio de la hora UTC), `ballots` | único `(election_id, hour)` |
| `reports` | `election_id` | El informe de 4.3 tal cual | `tallied_at` desc |
| `processed_events` | `event_id` | `event_type`, `processed_at` | — |
| `dashboard_users` | correo | `name`, `password_hash` (argon2id), `created_at` | — |
| `dashboard_sessions` | SHA-256 del token | `email`, `created_at`, `expires_at` | TTL sobre `expires_at` |

---

## 6. Pendientes de coordinación (plan P2)

| Tema | Con quién | Propuesta de este contrato |
| --- | --- | --- |
| Exchange de `tally.completed` (SE-03) | Sebastian | Analytics escucha en `votes.events` y `tally.events` |
| Formato de `votes.cast` y `tally.completed` (sección 3.8) | Sebastian y Andres | Secciones 3.4 y 3.5 |
| Evento con el tamaño del censo | Kevin | `census.updated` en `identity.events` (3.3); sin él, participación y abstención salen `null` |
| Metadatos de la elección | Fabian | `election.created` / `election.closed` en `election.events` (3.1, 3.2) |
| Respuesta HTTP para el frontend | Cristhian | Sección 4; el Gateway enruta `/v1/analytics/*` y restringe `recompute` a admin |

## 7. Panel web (`/dashboard`)

El binario de Rust embebe el panel (HTML, CSS y JS en `web/`, gráficas SVG propias, sin
dependencias de terceros salvo la fuente Public Sans de Google Fonts). Usa el mismo sistema
visual que la plataforma (`platform/app/globals.css`).

| Ruta | Descripción |
| --- | --- |
| `GET /` | Redirige a `/dashboard` |
| `GET /dashboard/login` | Formulario de acceso (correo + contraseña) |
| `GET /dashboard` | Panel; sin sesión válida redirige a `/dashboard/login` |
| `GET /dashboard/assets/{archivo}` | `app.css`, `app.js`, `charts.js`, `login.js`, `logo.png` |
| `POST /dashboard/api/login` | `{ "email", "password" }` → `200 { "user": { "email", "name" } }` + cookie de sesión |
| `POST /dashboard/api/logout` | Cierra la sesión → `204` |
| `GET /dashboard/api/me` | Usuario de la sesión |
| `GET /dashboard/api/live` | Participación en vivo (formato 4.5) de las elecciones sin conteo oficial |
| `GET/POST /dashboard/api/…` | Las mismas rutas de la sección 4 (`/summary`, `/elections`, `/elections/{id}`, `…/results`, `…/participation`, `…/turnout`, `…/recompute`) |

Vistas del panel:

- **Resumen** (`#/`): indicadores globales, participación en vivo (se actualiza cada 30 s),
  participación y margen de victoria por elección, destacados y elecciones recientes.
- **Elecciones** (`#/elections`): listado paginado.
- **Informe** (`#/elections/{id}`): ganador, segundo lugar y margen; censo, papeletas,
  participación, válidos, nulos y blancos; barras por opción; dona de composición del
  censo; tabla de resultados; participación por hora o por día con la participación
  acumulada; distribución por hora del día; competitividad y consistencia del dato. Si la
  elección no tiene conteo oficial, muestra su participación en vivo.

Seguridad del acceso:

| Aspecto | Implementación |
| --- | --- |
| Usuarios | Colección `dashboard_users` (`_id` = correo en minúsculas, hash **argon2id**). El usuario de `ANALYTICS_DASHBOARD_EMAIL`/`_PASSWORD` se crea o actualiza al arrancar |
| Sesión | Token aleatorio de 256 bits en la cookie `analytics_session` (`HttpOnly; SameSite=Strict; Path=/dashboard`, `Secure` con `ANALYTICS_COOKIE_SECURE=true`), 8 h. En `dashboard_sessions` solo se guarda su SHA-256, con índice TTL |
| Fuerza bruta | 5 intentos fallidos seguidos bloquean el correo 5 minutos (`429 too_many_attempts`); un correo inexistente tarda lo mismo que uno válido |
| CSRF | Cookie `SameSite=Strict` y cabecera obligatoria `X-Requested-With` en `POST` (`403 csrf_header_missing`) |
| Cabeceras | `Content-Security-Policy` restrictiva, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` |
| Errores | `401 invalid_credentials` (login), `401 unauthenticated` (API sin sesión) |

## 8. Configuración

| Variable | Defecto | Descripción |
| --- | --- | --- |
| `ANALYTICS_HTTP_ADDR` | `0.0.0.0:8090` | Dirección HTTP. `PORT` (Cloud Run) tiene prioridad |
| `ANALYTICS_MONGODB_URI` | `mongodb://localhost:27017` | MongoDB «Results» |
| `ANALYTICS_MONGODB_DATABASE` | `results` | |
| `ANALYTICS_RABBITMQ_URI` | `amqp://guest:guest@localhost:5672/%2f` | |
| `ANALYTICS_PREFETCH` | `16` | Mensajes en vuelo por consumidor |
| `ANALYTICS_DASHBOARD_EMAIL` | — | Correo del usuario del panel |
| `ANALYTICS_DASHBOARD_PASSWORD` | — | Su contraseña (se guarda con argon2id) |
| `ANALYTICS_DASHBOARD_NAME` | `Administración` | Nombre visible en el panel |
| `ANALYTICS_COOKIE_SECURE` | `false` | `true` detrás de HTTPS |
| `RUST_LOG` | `info` | Nivel de logs (JSON a stdout) |
