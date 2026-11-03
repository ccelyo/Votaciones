-- Base de datos «Elections» del servicio Election (FA-02).
--
-- Fuente de verdad del esquema; app/models.py la refleja y tests/test_schema.py
-- falla si ambos dejan de coincidir. Modelo entidad-relación en docs/modelo-datos.md.
--
-- Hacia fuera (API, eventos, Ballot, token) el identificador de una elección es
-- SIEMPRE el texto de elections.id (p. ej. "7").
-- Todas las fechas son TIMESTAMPTZ y se manejan en UTC.

-- Elecciones y su ciclo de vida (reglas en docs/reglas-negocio.md).
CREATE TABLE elections (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description VARCHAR(1000) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    opens_at TIMESTAMPTZ NOT NULL,
    closes_at TIMESTAMPTZ NOT NULL,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,

    CONSTRAINT ck_elections_status
        CHECK (status IN ('draft', 'open', 'closed')),
    CONSTRAINT ck_elections_window
        CHECK (closes_at > opens_at),
    -- opened_at existe desde que la urna se abre; closed_at solo al cerrarla.
    CONSTRAINT ck_elections_lifecycle
        CHECK (
            (status = 'draft' AND opened_at IS NULL AND closed_at IS NULL)
            OR (status = 'open' AND opened_at IS NOT NULL AND closed_at IS NULL)
            OR (status = 'closed' AND opened_at IS NOT NULL AND closed_at IS NOT NULL)
        )
);

CREATE INDEX ix_elections_status_window ON elections (status, opens_at, closes_at);

-- Opciones de la papeleta, en el orden en que se muestran.
CREATE TABLE election_options (
    election_id INTEGER NOT NULL,
    position SMALLINT NOT NULL,
    label VARCHAR(128) NOT NULL,
    is_blank BOOLEAN NOT NULL DEFAULT FALSE,

    CONSTRAINT pk_election_options
        PRIMARY KEY (election_id, position),
    CONSTRAINT fk_election_options_election
        FOREIGN KEY (election_id)
        REFERENCES elections(id)
        ON DELETE CASCADE,
    CONSTRAINT uq_election_options_label
        UNIQUE (election_id, label),
    CONSTRAINT ck_election_options_position
        CHECK (position >= 0)
);

-- Como máximo una opción de voto en blanco por elección.
CREATE UNIQUE INDEX uq_election_options_one_blank
    ON election_options (election_id) WHERE is_blank;

-- Llaves de la urna (FA-09), 1 a 1 con la elección. Se generan al abrirla.
-- La privada se guarda cifrada con AES-256-GCM bajo la llave maestra del servicio
-- (ELECTION_URN_KEK); kek_id identifica con qué llave maestra se cifró.
CREATE TABLE urn_keys (
    election_id INTEGER PRIMARY KEY,
    algorithm VARCHAR(64) NOT NULL,
    public_key_der BYTEA NOT NULL,
    wrapped_private_key BYTEA NOT NULL,
    wrap_nonce BYTEA NOT NULL,
    kek_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TIMESTAMPTZ,
    release_count INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT fk_urn_keys_election
        FOREIGN KEY (election_id)
        REFERENCES elections(id)
        ON DELETE CASCADE
);

-- Parámetros públicos firmados que descargan los clientes antes de cifrar el voto.
CREATE TABLE election_parameters (
    election_id INTEGER PRIMARY KEY,
    signed_parameters BYTEA NOT NULL,
    signing_key_id VARCHAR(64) NOT NULL,
    signature_algorithm VARCHAR(64) NOT NULL,
    signature BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_election_parameters_election
        FOREIGN KEY (election_id)
        REFERENCES elections(id)
        ON DELETE CASCADE
);

-- Bitácora de acciones administrativas sobre cada elección.
CREATE TABLE election_audit (
    id BIGSERIAL PRIMARY KEY,
    election_id INTEGER NOT NULL,
    action VARCHAR(32) NOT NULL,
    actor VARCHAR(64) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_election_audit_election
        FOREIGN KEY (election_id)
        REFERENCES elections(id)
        ON DELETE CASCADE,
    CONSTRAINT ck_election_audit_action
        CHECK (action IN ('created', 'updated', 'opened', 'closed', 'urn_key_released'))
);

CREATE INDEX ix_election_audit_election ON election_audit (election_id, occurred_at);

-- Outbox transaccional de election.events (FA-06). El evento se inserta en la
-- misma transacción que el cambio de estado y un proceso aparte lo publica en
-- RabbitMQ. event_id se conserva entre reintentos para que los consumidores
-- descarten duplicados.
CREATE TABLE outbox_events (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error VARCHAR(500)
);

CREATE INDEX ix_outbox_events_pending ON outbox_events (id) WHERE published_at IS NULL;
