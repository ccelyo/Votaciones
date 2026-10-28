# Analytics (Rust)

Consume los eventos de RabbitMQ (`election.events`, `identity.events`, `votes.events`,
`tally.events`), calcula la participación en tiempo real a partir de `votes.cast`, guarda
en su MongoDB «Results» las analíticas de cada elección **ya cerrada** (a partir de
`tally.completed`, conteo oficial de Tally) y las expone por REST/JSON y en un **panel web** con gráficas. Sigue el plan
`docs/plan-prototipos/02-Prototype.md` (sección 3.8). Contratos completos (eventos, API, colecciones): [CONTRACTS.md](CONTRACTS.md).

## Ejecutar

```bash
docker compose up --build                      # mongo-results + rabbitmq + analytics
docker compose exec analytics /publish-sample  # 2 elecciones finalizadas + 1 en curso
open http://localhost:8090/dashboard           # admin@espivota.dev / prueba123 (solo desarrollo)
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
| `src/auth.rs` | Usuarios del panel, argon2id, sesiones y bloqueo por intentos |
| `src/web.rs` | Panel web: páginas, recursos embebidos, login y API con sesión |
| `web/` | HTML, CSS, JS y gráficas SVG del panel (se embeben al compilar) |
| `src/bin/publish_sample.rs` | Publicador de una elección de ejemplo |
