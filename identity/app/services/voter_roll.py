"""Padrón electoral sobre Census.

Cada función recibe dos sesiones: ``session`` (base de Identity/Auth, donde viven
los usuarios y, por ahora, las elecciones) y ``census`` (base Census, donde viven
el padrón y las credenciales emitidas). No hay transacciones entre ambas bases:
primero se valida contra ``session`` y después se escribe en ``census``.
"""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import InvalidRequest
from app.db.census import IssuedCredential, VoterRollEntry
from app.db.models import User
from app.services.elections import election_ref, get_election


@dataclass(frozen=True)
class VoterRollData:
    user_id: int
    election_id: str
    is_eligible: bool
    has_voted: bool


@dataclass(frozen=True)
class VoterStatus:
    election_id: str
    is_eligible: bool
    has_voted: bool
    token_issued: bool


def _data(entry: VoterRollEntry) -> VoterRollData:
    return VoterRollData(
        user_id=int(entry.voter_id),
        election_id=entry.election_id,
        is_eligible=entry.is_eligible,
        has_voted=entry.has_voted,
    )


def _entry(census: Session, election_id: str, user_id: int) -> VoterRollEntry | None:
    return census.scalar(
        select(VoterRollEntry).where(
            VoterRollEntry.election_id == election_id,
            VoterRollEntry.voter_id == str(user_id),
        )
    )


def _issued(census: Session, election_id: str, user_id: int) -> bool:
    return (
        census.scalar(
            select(IssuedCredential.id).where(
                IssuedCredential.election_id == election_id,
                IssuedCredential.voter_id == str(user_id),
            )
        )
        is not None
    )


def enroll_voter(
    session: Session,
    census: Session,
    *,
    election_id: str,
    user_id: int,
    is_eligible: bool = True,
) -> VoterRollData:
    election = election_ref(get_election(session, election_id))

    user = session.get(User, user_id)
    if user is None:
        raise InvalidRequest("user does not exist")
    if not user.is_active:
        raise InvalidRequest("user is inactive")

    entry = VoterRollEntry(
        election_id=election, voter_id=str(user.id), is_eligible=is_eligible, has_voted=False
    )
    census.add(entry)
    try:
        census.commit()
    except IntegrityError as error:
        census.rollback()
        raise InvalidRequest("user is already enrolled in this election") from error
    return _data(entry)


def get_voter_roll(session: Session, census: Session, *, election_id: str) -> list[VoterRollData]:
    election = election_ref(get_election(session, election_id))
    entries = census.scalars(
        select(VoterRollEntry).where(VoterRollEntry.election_id == election)
    ).all()
    return sorted((_data(entry) for entry in entries), key=lambda data: data.user_id)


def update_voter_eligibility(
    session: Session,
    census: Session,
    *,
    election_id: str,
    user_id: int,
    is_eligible: bool,
) -> VoterRollData:
    election = election_ref(get_election(session, election_id))
    entry = _entry(census, election, user_id)
    if entry is None:
        raise InvalidRequest("user is not enrolled in this election")
    entry.is_eligible = is_eligible
    census.commit()
    return _data(entry)


def confirm_vote(
    session: Session, census: Session, *, election_id: str, user_id: int
) -> VoterRollData:
    election = election_ref(get_election(session, election_id))
    entry = _entry(census, election, user_id)
    if entry is None:
        raise InvalidRequest("user is not enrolled in this election")
    if not entry.is_eligible:
        raise InvalidRequest("user is not eligible for this election")

    # Identity solo verifica que previamente emitió una credencial al votante.
    # No conoce qué token anónimo ni qué papeleta fue usada en Ballot.
    if not _issued(census, election, user_id):
        raise InvalidRequest("no token was issued for this user and election")

    # La confirmación es idempotente.
    if not entry.has_voted:
        entry.has_voted = True
        census.commit()
    return _data(entry)


def voter_status(
    session: Session, census: Session, *, election_id: str, user_id: int
) -> VoterStatus:
    """Situación del usuario autenticado en una elección (para la UI de voto)."""
    election = election_ref(get_election(session, election_id))
    entry = _entry(census, election, user_id)
    return VoterStatus(
        election_id=election,
        is_eligible=entry is not None and entry.is_eligible,
        has_voted=entry is not None and entry.has_voted,
        token_issued=_issued(census, election, user_id),
    )
