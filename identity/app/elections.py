"""Urnas: alta, parámetros públicos, cierre y estado.

La urna se persiste en PostgreSQL y se registra en `ballot` por gRPC. `ballot`
tolera repetir un registro idéntico, así que un alta que falló a medias se puede
reintentar con los mismos datos.
"""

import re
import time
import uuid
from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import blind_rsa, parameters
from app.ballot_client import BallotGateway, ElectionRegistration, TokenKey
from app.errors import ElectionAlreadyExists, ElectionNotFound, InvalidRequest
from app.keys import IdentityKeys
from app.models import STATUS_CLOSED, STATUS_OPEN, Election

# Límites alineados con la validación de `ballot` (admin.go).
MAX_OPTIONS = 100
MAX_OPTION_BYTES = 128
MAX_ENCRYPTION_KEY_BYTES = 64 * 1024
_ID_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{1,128}$")


@dataclass(frozen=True)
class ElectionStatus:
    election_id: str
    identity_status: str
    ballot_status: str
    total_ballots: int


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


def create_election(
    session: Session,
    ballot: BallotGateway,
    keys: IdentityKeys,
    *,
    election_id: str | None,
    options: list[str],
    encryption_public_key: bytes,
    opens_at: int,
    closes_at: int,
    now: int | None = None,
) -> Election:
    now = int(time.time()) if now is None else now
    election_id = election_id or uuid.uuid4().hex
    if not _ID_PATTERN.fullmatch(election_id):
        raise InvalidRequest("election id must match [A-Za-z0-9._~-]{1,128}")
    options = _validate_options(options)
    if not 0 < len(encryption_public_key) <= MAX_ENCRYPTION_KEY_BYTES:
        raise InvalidRequest("encryption public key has an invalid size")
    if b"PRIVATE KEY" in encryption_public_key:
        raise InvalidRequest("encryption_public_key must be a public key")
    if opens_at <= 0 or closes_at <= opens_at:
        raise InvalidRequest("closes_at must be after opens_at")
    if closes_at <= now:
        raise InvalidRequest("closes_at must be in the future")
    if session.get(Election, election_id) is not None:
        raise ElectionAlreadyExists()

    token_key = TokenKey(
        kid=keys.token_kid,
        public_key_der=keys.token_public_der,
        signature_variant=blind_rsa.VARIANT,
    )
    signed_parameters = parameters.canonical_parameters(
        election_id=election_id,
        options=options,
        encryption_public_key=encryption_public_key,
        opens_at=opens_at,
        closes_at=closes_at,
        token_key=token_key,
    )
    signature = parameters.sign_parameters(keys.parameter_private, signed_parameters)

    election = Election(
        id=election_id,
        options=options,
        encryption_public_key=encryption_public_key,
        opens_at=opens_at,
        closes_at=closes_at,
        status=STATUS_OPEN,
        token_kid=token_key.kid,
        token_public_key_der=token_key.public_key_der,
        token_variant=token_key.signature_variant,
        signed_parameters=signed_parameters,
        parameter_signing_key_id=keys.parameter_key_id,
        parameter_signature_algorithm=parameters.ALGORITHM,
        parameter_signature=signature,
    )
    session.add(election)
    try:
        session.flush()
    except IntegrityError as error:
        session.rollback()
        raise ElectionAlreadyExists() from error

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
    session.commit()
    return election


def get_election(session: Session, election_id: str) -> Election:
    election = session.get(Election, election_id)
    if election is None:
        raise ElectionNotFound()
    return election


def close_election(session: Session, ballot: BallotGateway, election_id: str) -> Election:
    """Cierra primero en `ballot` (idempotente) y luego marca la urna como cerrada."""
    election = get_election(session, election_id)
    ballot.close_election(election_id)
    election.status = STATUS_CLOSED
    session.commit()
    return election


def election_status(session: Session, ballot: BallotGateway, election_id: str) -> ElectionStatus:
    election = get_election(session, election_id)
    return ElectionStatus(
        election_id=election.id,
        identity_status=election.status,
        ballot_status=ballot.get_election_status(election_id),
        total_ballots=ballot.count_ballots(election_id),
    )
