# Modelo de datos de las elecciones (FA-01)

Base PostgreSQL **«Elections»**, exclusiva del servicio Election. El DDL está en
[`../schema.sql`](../schema.sql) (fuente de verdad) y se refleja en `app/models.py`.

```mermaid
erDiagram
    ELECTIONS ||--|{ ELECTION_OPTIONS : "tiene (2..100)"
    ELECTIONS ||--o| URN_KEYS : "se cifra con"
    ELECTIONS ||--o| ELECTION_PARAMETERS : "publica"
    ELECTIONS ||--o{ ELECTION_AUDIT : "registra"

    ELECTIONS {
        serial id PK "texto = election_id externo"
        varchar name "1..150"
        varchar description "0..1000"
        varchar status "draft | open | closed"
        timestamptz opens_at
        timestamptz closes_at "> opens_at"
        varchar created_by "sub del JWT"
        timestamptz created_at
        timestamptz updated_at
        timestamptz opened_at "solo open/closed"
        timestamptz closed_at "solo closed"
    }
    ELECTION_OPTIONS {
        int election_id PK, FK
        smallint position PK "orden en la papeleta"
        varchar label "único por elección"
        boolean is_blank "máx. uno por elección"
    }
    URN_KEYS {
        int election_id PK, FK
        varchar algorithm "RSA-OAEP-256+A256GCM"
        bytea public_key_der "SPKI DER"
        bytea wrapped_private_key "AES-256-GCM bajo la KEK"
        bytea wrap_nonce
        varchar kek_id
        timestamptz created_at
        timestamptz released_at
        int release_count
    }
    ELECTION_PARAMETERS {
        int election_id PK, FK
        bytea signed_parameters "JSON canónico"
        varchar signing_key_id
        varchar signature_algorithm "Ed25519"
        bytea signature
        timestamptz created_at
    }
    ELECTION_AUDIT {
        bigserial id PK
        int election_id FK
        varchar action "created | updated | opened | closed | urn_key_released"
        varchar actor
        timestamptz occurred_at
    }
    OUTBOX_EVENTS {
        bigserial id PK "orden de publicación"
        uuid event_id UK
        varchar event_type "routing key"
        jsonb payload "sobre completo"
        timestamptz created_at
        timestamptz published_at "NULL = pendiente"
        int attempts
        varchar last_error
    }
```

`OUTBOX_EVENTS` no tiene clave foránea: es una cola técnica y sus filas deben
sobrevivir aunque el evento se refiera a una elección borrada.

## Entidades

| Tabla | Rol | Notas |
| --- | --- | --- |
| `elections` | Elección y su ciclo de vida | `ck_elections_lifecycle` garantiza que `opened_at`/`closed_at` sean coherentes con `status` |
| `election_options` | Opciones de la papeleta | PK `(election_id, position)` conserva el orden; `uq_election_options_one_blank` (índice parcial) admite un solo voto en blanco |
| `urn_keys` | Llaves de la urna (FA-09) | Se crea al abrir. La privada nunca se guarda en claro |
| `election_parameters` | Parámetros públicos firmados | Bytes exactos que verifica el cliente |
| `election_audit` | Bitácora administrativa | Quién creó, abrió, cerró o pidió la llave privada |
| `outbox_events` | Outbox de `election.events` | Índice parcial sobre los pendientes |

## Decisiones

- **Identificador.** `SERIAL`; hacia fuera viaja como texto (`"7"`), igual que en el
  prototipo 1, para que Ballot, Identity y el token anónimo no cambien de formato.
- **Opciones normalizadas** (no un arreglo JSON): permiten las restricciones de
  unicidad y de un solo blanco en la propia base.
- **`TIMESTAMPTZ`** en todas las fechas; la aplicación trabaja siempre en UTC.
- **Sin datos de votantes.** El padrón (Census) es de Identity y las papeletas de
  Ballot: esta base no puede enlazar a nadie con su voto.
- **Borrado** solo de borradores; `ON DELETE CASCADE` limpia opciones y bitácora.
