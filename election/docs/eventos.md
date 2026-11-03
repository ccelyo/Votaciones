# Eventos `election.events` (FA-06)

Productor: servicio Election. Coordinado con Sebastian (SE-02/SE-03); compatible con
`analytics/CONTRACTS.md` §3.1–3.2 y con los consumidores de `notification/`.

## Topología

| Recurso | Valor |
| --- | --- |
| Exchange | `election.events`, `topic`, `durable=true` (Election lo declara de forma idempotente) |
| Routing key | Igual a `event_type` |
| Propiedades | `content_type=application/json`, `delivery_mode=2`, `message_id=event_id`, `type=event_type`, `app_id=election` |
| Confirmación | Publisher confirms: un evento solo se marca publicado tras el `ack` del broker |

Consumidores conocidos:

| Cola | Routing keys | Dueño |
| --- | --- | --- |
| `analytics.events` | `election.created`, `election.closed` | Sergio |
| `notifications.election` | `election.created`, `election.closed` | Camilo |
| (pendiente, AN-10) | `election.created`, `election.closed` | Andres (Ballot) |

> Election no publica con `mandatory`: un mensaje que no tenga cola enlazada se
> descarta. Las colas de los consumidores deben existir antes (las declaran ellos o
> la definición de RabbitMQ de SE-02).

## Garantías (outbox transaccional)

1. El caso de uso inserta el evento en `outbox_events` en la misma transacción que
   el cambio de estado: si la transacción falla, no hay evento.
2. Un hilo (`OutboxRelay`) publica los pendientes **en orden de `id`**. Ante un
   fallo se detiene y reintenta en el siguiente ciclo (1 s), así `election.closed`
   nunca adelanta a `election.created`.
3. **Al menos una vez**: el `event_id` se conserva entre reintentos; los
   consumidores descartan duplicados por `event_id`.
4. El orden está garantizado con una sola instancia publicadora (la imagen corre un
   solo proceso). Con varias réplicas no se duplican eventos (`FOR UPDATE SKIP
   LOCKED`), pero dos lotes podrían publicarse intercalados.
5. `GET /ready` informa `events_published=false` mientras haya eventos atrasados.

## Sobre común

```json
{
  "event_id": "1b4e28ba-2fa1-4d2a-883f-0016d3cca427",
  "event_type": "election.created",
  "occurred_at": "2026-11-20T13:00:00Z",
  "producer": "election",
  "schema_version": 1,
  "data": { }
}
```

## `election.created`

Se emite al **abrir** la elección (los borradores son privados y no generan eventos).

```json
{
  "election_id": "7",
  "name": "Consejo Superior 2026",
  "description": "Representante estudiantil",
  "options": ["Candidata A", "Candidato B", "Voto en blanco"],
  "blank_option": "Voto en blanco",
  "opens_at": "2026-11-20T13:00:00Z",
  "closes_at": "2026-11-20T21:00:00Z",
  "encryption": {
    "algorithm": "RSA-OAEP-256+A256GCM",
    "public_key": "<SPKI DER, base64url>",
    "public_key_format": "spki-der"
  },
  "signed_parameters": "<JSON canónico, base64url>",
  "signature": { "key_id": "9f2c…", "algorithm": "Ed25519", "value": "<base64url>" }
}
```

`blank_option` puede ser `null`. `encryption`, `signed_parameters` y `signature`
son lo que Ballot necesita para registrar la urna (AN-10); Analytics y
Notifications los ignoran.

## `election.opened`

```json
{
  "election_id": "7",
  "opened_at": "2026-11-20T12:55:00Z",
  "opens_at": "2026-11-20T13:00:00Z",
  "closes_at": "2026-11-20T21:00:00Z"
}
```

Previsto en la vista; hoy ningún consumidor lo procesa.

## `election.closed`

```json
{ "election_id": "7", "closed_at": "2026-11-20T21:00:00Z", "reason": "schedule" }
```

`reason`: `manual` (cierre del administrador) o `schedule` (fin de la ventana).
