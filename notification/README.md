# Notifications

Servicio TypeScript que transforma eventos del sistema en notificaciones persistidas
en MongoDB. La lógica está organizada en capas:

- `domain`: contratos de eventos y notificaciones.
- `application`: handlers y caso de uso de procesamiento.
- `infrastructure`: RabbitMQ, MongoDB y HTTP.

## Consumidores

Cada grupo de eventos tiene su propia cola durable y su propia DLQ:

| Cola | Exchange | Routing keys |
| --- | --- | --- |
| `notifications.election` | `election.events` | `election.created`, `election.closed` |
| `notifications.identity` | `identity.events` | `census.updated` |
| `notifications.votes` | `votes.events` | `votes.cast` |
| `notifications.tally` | `votes.events`, `tally.events` | `tally.completed` |

Las tres instancias usan `RabbitConsumer<T>`, una abstracción genérica que recibe
bindings, decodificador y handler. Para agregar un evento, se registra un handler y
se crea un consumidor con sus bindings; RabbitMQ se encarga de entregar cada mensaje
una sola vez por cola. Los mensajes inválidos o que no se pueden procesar van a la
DLQ correspondiente.

Los registros son idempotentes mediante un índice único sobre `eventId`.

## Ejecución

```bash
cp .env.example .env
pnpm install
pnpm run tsc
pnpm test
pnpm dev
```

Variables requeridas: `MONGO_URL` y `RABBIT_URL`. El endpoint
`GET /v1/notifications?recipientId=<id>&limit=50` consulta el historial.
Los eventos sin destinatario explícito se guardan con `recipientId=broadcast`.

Desde la raíz, `docker compose up --build` levanta el servicio junto con sus
dependencias. El endpoint público del Gateway es `GET /api/notifications`.
