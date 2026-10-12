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

-- Padrón electoral: relación entre usuarios y elecciones.
CREATE TABLE voter_roll (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    election_id INTEGER NOT NULL,
    is_eligible BOOLEAN NOT NULL DEFAULT TRUE,
    has_voted BOOLEAN NOT NULL DEFAULT FALSE,

    CONSTRAINT fk_voter_roll_user
        FOREIGN KEY (user_id)
        REFERENCES users(id),

    CONSTRAINT fk_voter_roll_election
        FOREIGN KEY (election_id)
        REFERENCES elections(id),

    CONSTRAINT uq_voter_roll_user_election
        UNIQUE (user_id, election_id)
);

-- Registro de emisión de tokens.
-- Un usuario solo puede recibir un token por elección.
CREATE TABLE issued_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    election_id INTEGER NOT NULL,
    issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_issued_tokens_user
        FOREIGN KEY (user_id)
        REFERENCES users(id),

    CONSTRAINT fk_issued_tokens_election
        FOREIGN KEY (election_id)
        REFERENCES elections(id),

    CONSTRAINT uq_issued_tokens_user_election
        UNIQUE (user_id, election_id)
);

-- Roles iniciales del sistema.
INSERT INTO roles (name)
VALUES
    ('admin'),
    ('voter')
ON CONFLICT (name) DO NOTHING;