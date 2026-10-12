"""Urnas: alta, parámetros públicos, cierre y estado.

La urna se guarda en las tablas de Kevin (``elections``) más ``election_parameters``,
y se registra en `ballot` por gRPC. Hacia fuera (API, token, `ballot`) el
identificador de la elección es SIEMPRE el texto de ``elections.id``: `ballot` lo
valida como texto y viaja dentro del token anónimo. Solo este módulo convierte
entre ese texto y el entero de PostgreSQL.
"""

import time
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app import blind_rsa, parameters
from app.ballot_client import BallotGateway, ElectionRegistration, TokenKey
from app.errors import ElectionNotFound, InvalidRequest
from app.keys import IdentityKeys
from app.models import (
    STATUS_CLOSED,
    STATUS_DRAFT,
    STATUS_OPEN,
    Election,
    ElectionParameters,
)

# Límites alineados con la validación de `ballot` (admin.go) y el esquema de Kevin.
MAX_NAME = 150
MAX_OPTIONS = 100
MAX_OPTION_BYTES = 128
MAX_ENCRYPTION_KEY_BYTES = 64 * 1024


@dataclass(frozen=True)
class ElectionStatus:
    election_id: str
    identity_status: str
    ballot_status: str
    total_ballots: int


# --- conversiones id y tiempo ----------------------------------------------


def election_ref(election: Election) -> str:
    """Identificador externo (texto) de una elección."""
    return str(election.id)


def parse_election_id(raw: str) -> int:
    if not raw.isascii() or not raw.isdigit() or not 0 < int(raw) < 2**31:
        raise ElectionNotFound()
    return int(raw)


def to_db_time(epoch_seconds: int) -> datetime:
    """TIMESTAMP sin zona: se guarda UTC naive."""
    return datetime.fromtimestamp(epoch_seconds, UTC).replace(tzinfo=None)


def to_epoch(value: datetime) -> int:
    return int(value.replace(tzinfo=UTC).timestamp())


def is_open_for_tokens(election: Election, now: int) -> bool:
    """Urna publicada y dentro de su ventana de votación."""
    if election.status != STATUS_OPEN or election.starts_at is None or election.ends_at is None:
        return False
    return to_epoch(election.starts_at) <= now < to_epoch(election.ends_at)


# --- validación --------------------------------------------------------------


def _validate_name(name: str) -> str:
    if (
        not name
        or name != name.strip()
        or len(name) > MAX_NAME
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in name)
    ):
        raise InvalidRequest(f"name must be trimmed text of 1 to {MAX_NAME} characters")
    return name


def _validate_options(options: list[str]) -> list[str]:
    if not 2 <= len(options) <= MAX_OPTIONS:
        raise InvalidRequest(f"an election needs between 2 and {MAX_OPTIONS} options")
    cleaned: list[str] = []
    for option in options:
        if (
            not option
            or option != option.strip()
            or len(option.encode("utf-8")) > MAX_OPTION_BYTES
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in option)
        ):
            raise InvalidRequest("options must be non-empty, trimmed text without control characters")
        cleaned.append(option)
    if len(set(cleaned)) != len(cleaned):
        raise InvalidRequest("options must be unique")
    return cleaned


# --- casos de uso ------------------------------------------------------------


def create_election(
    session: Session,
    ballot: BallotGateway,
    keys: IdentityKeys,
    *,
    name: str,
    options: list[str],
    encryption_public_key: bytes,
    opens_at: int,
    closes_at: int,
    now: int | None = None,
) -> Election:
    """Crea la urna, firma sus parámetros y la registra en `ballot`.

    El id lo asigna PostgreSQL, por eso la fila se inserta primero (``draft``) y
    solo pasa a ``open`` cuando `ballot` confirma el registro. Si `ballot` falla se
    revierte todo; un reintento obtiene otro id.
    """
    now = int(time.time()) if now is None else now
    name = _validate_name(name)
    options = _validate_options(options)
    if not 0 < len(encryption_public_key) <= MAX_ENCRYPTION_KEY_BYTES:
        raise InvalidRequest("encryption public key has an invalid size")
    if b"PRIVATE KEY" in encryption_public_key:
        raise InvalidRequest("encryption_public_key must be a public key")
    if opens_at <= 0 or closes_at <= opens_at:
        raise InvalidRequest("closes_at must be after opens_at")
    if closes_at <= now:
        raise InvalidRequest("closes_at must be in the future")

    election = Election(
        name=name,
        status=STATUS_DRAFT,
        starts_at=to_db_time(opens_at),
        ends_at=to_db_time(closes_at),
    )
    session.add(election)
    session.flush()  # asigna elections.id
    election_id = election_ref(election)

    token_key = TokenKey(
        kid=keys.token_kid,
        public_key_der=keys.token_public_der,
        signature_variant=blind_rsa.VARIANT,
    )
    signed_parameters = parameters.canonical_parameters(
        election_id=election_id,
        name=name,
        options=options,
        encryption_public_key=encryption_public_key,
        opens_at=opens_at,
        closes_at=closes_at,
        token_key=token_key,
    )
    signature = parameters.sign_parameters(keys.parameter_private, signed_parameters)

    session.add(
        ElectionParameters(
            election_id=election.id,
            options=options,
            encryption_public_key=encryption_public_key,
            token_kid=token_key.kid,
            token_public_key_der=token_key.public_key_der,
            token_variant=token_key.signature_variant,
            signed_parameters=signed_parameters,
            parameter_signing_key_id=keys.parameter_key_id,
            parameter_signature_algorithm=parameters.ALGORITHM,
            parameter_signature=signature,
        )
    )
    session.flush()

    try:
        ballot.register_election(
            ElectionRegistration(
                election_id=election_id,
                options=options,
                encryption_public_key=encryption_public_key,
                token_keys=[token_key],
                opens_at=opens_at,
                closes_at=closes_at,
                signed_parameters=signed_parameters,
                parameter_signing_key_id=keys.parameter_key_id,
                parameter_signature_algorithm=parameters.ALGORITHM,
                parameter_signature=signature,
            )
        )
    except Exception:
        session.rollback()
        raise

    election.status = STATUS_OPEN
    session.commit()
    return election


def get_election(session: Session, election_id: str) -> Election:
    election = session.get(Election, parse_election_id(election_id))
    if election is None:
        raise ElectionNotFound()
    return election


def get_parameters(session: Session, election_id: str) -> tuple[Election, ElectionParameters]:
    election = get_election(session, election_id)
    stored = session.get(ElectionParameters, election.id)
    if stored is None:
        # Elección creada fuera de este servicio (sin parámetros firmados).
        raise ElectionNotFound("election has no published parameters")
    return election, stored


def close_election(session: Session, ballot: BallotGateway, election_id: str) -> Election:
    """Cierra primero en `ballot` (idempotente) y luego marca la urna como cerrada."""
    election = get_election(session, election_id)
    ballot.close_election(election_ref(election))
    election.status = STATUS_CLOSED
    session.commit()
    return election


def election_status(session: Session, ballot: BallotGateway, election_id: str) -> ElectionStatus:
    election = get_election(session, election_id)
    reference = election_ref(election)
    return ElectionStatus(
        election_id=reference,
        identity_status=election.status,
        ballot_status=ballot.get_election_status(reference),
        total_ballots=ballot.count_ballots(reference),
    )
