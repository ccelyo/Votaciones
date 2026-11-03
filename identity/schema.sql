-- Roles disponibles en el sistema.
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

-- Usuarios que pueden autenticarse en el sistema.
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role_id INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_users_role
        FOREIGN KEY (role_id)
        REFERENCES roles(id)
);

-- Elecciones disponibles y su estado.
CREATE TABLE elections (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'open', 'closed')),
    starts_at TIMESTAMP,
    ends_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- El padrón (voter_roll) y las credenciales emitidas (issued_credentials) ya no
-- viven aquí: pertenecen a la base Census (census/schema.sql).

-- Roles iniciales del sistema.
INSERT INTO roles (name)
VALUES
    ('admin'),
    ('voter')
ON CONFLICT (name) DO NOTHING;

-- Parámetros públicos de cada elección (M6), 1 a 1 con `elections`.
-- `ballot` los exige al registrar la urna y el navegador los descarga ya firmados.
-- El `election_id` que viaja a `ballot` y dentro del token es el texto de elections.id.
CREATE TABLE election_parameters (
    election_id INTEGER PRIMARY KEY,
    options JSONB NOT NULL,
    encryption_public_key BYTEA NOT NULL,
    token_kid VARCHAR(64) NOT NULL,
    token_public_key_der BYTEA NOT NULL,
    token_variant VARCHAR(64) NOT NULL,
    signed_parameters BYTEA NOT NULL,
    parameter_signing_key_id VARCHAR(64) NOT NULL,
    parameter_signature_algorithm VARCHAR(64) NOT NULL,
    parameter_signature BYTEA NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_election_parameters_election
        FOREIGN KEY (election_id)
        REFERENCES elections(id)
        ON DELETE CASCADE
);

-- Desafíos temporales del segundo factor de autenticación.
CREATE TABLE mfa_challenges (
    id SERIAL PRIMARY KEY,
    challenge_hash VARCHAR(64) NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_mfa_challenges_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);


-- Sesiones creadas después de completar login y MFA.
-- Solo se almacena el hash del token entregado al cliente.
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_sessions_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);