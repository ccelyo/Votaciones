# Analytics (Rust)

Consume los eventos de RabbitMQ (`election.events`, `identity.events`, `votes.events`),
guarda en su MongoDB «Results» las analíticas de cada elección **ya cerrada** y las
expone por REST/JSON. Contratos completos (eventos, API, colecciones): [CONTRACTS.md](CONTRACTS.md).

## Ejecutar

```bash
docker compose up --build                      # mongo-results + rabbitmq + analytics
docker compose exec analytics /publish-sample  # simula una elección terminada
curl localhost:8090/v1/analytics/elections/consejo-superior-2026
```

Desde la raíz del repo, `docker compose up --build` también levanta analytics
(`http://localhost:8090`) y RabbitMQ (`http://localhost:15672`, guest / guest).

Sin Docker (necesita MongoDB y RabbitMQ locales):

```bash
cargo run                       # servicio
cargo run --bin publish-sample  # eventos de ejemplo
```

## Desarrollo

```bash
cargo test
cargo clippy --all-targets
cargo fmt
```

| Módulo | Responsabilidad |
| --- | --- |
| `src/events.rs` | Sobre y payloads de los eventos, decodificación y validación |
| `src/report.rs` | Cálculo puro del informe y del resumen global (con tests) |
| `src/store.rs` | Colecciones MongoDB, idempotencia y recálculo |
| `src/consumer.rs` | Topología RabbitMQ, consumo, DLQ y reconexión |
| `src/http.rs` | API HTTP (axum) |
| `src/bin/publish_sample.rs` | Publicador de una elección de ejemplo |
