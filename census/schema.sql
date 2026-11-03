-- Census: base de datos PostgreSQL del padrón electoral (independiente de Auth).
-- Sin claves foráneas hacia users/elections: viven en otras bases (Auth y Election).
-- voter_id y election_id son identificadores opacos que llegan desde Identity.

-- Padrón: un votante puede votar en una elección si is_eligible.
CREATE TABLE voter_roll (
    id SERIAL PRIMARY KEY,
    election_id VARCHAR(128) NOT NULL,
    voter_id VARCHAR(64) NOT NULL,
    is_eligible BOOLEAN NOT NULL DEFAULT TRUE,
    has_voted BOOLEAN NOT NULL DEFAULT FALSE,

    CONSTRAINT uq_voter_roll_election_voter UNIQUE (election_id, voter_id)
);

-- Control de credenciales emitidas: una por votante y elección.
-- Solo se guarda el DÍA (no la hora) para no permitir correlación temporal con
-- la papeleta. Nunca se guarda el mensaje cegado, la firma ni el token.
CREATE TABLE issued_credentials (
    id SERIAL PRIMARY KEY,
    election_id VARCHAR(128) NOT NULL,
    voter_id VARCHAR(64) NOT NULL,
    issued_on DATE NOT NULL DEFAULT CURRENT_DATE,

    CONSTRAINT uq_issued_credentials_election_voter UNIQUE (election_id, voter_id)
);
