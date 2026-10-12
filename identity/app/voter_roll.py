from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.elections import get_election
from app.errors import ElectionNotFound, InvalidRequest
from app.models import User, VoterRollEntry


@dataclass(frozen=True)
class VoterRollData:
    user_id: int
    election_id: str
    is_eligible: bool
    has_voted: bool


def enroll_voter(
    session: Session,
    *,
    election_id: str,
    user_id: int,
    is_eligible: bool = True,
) -> VoterRollData:
    """Agrega un usuario al padrón de una elección."""

    election = get_election(session, election_id)

    user = session.get(User, user_id)

    if user is None:
        raise InvalidRequest("user does not exist")

    if not user.is_active:
        raise InvalidRequest("user is inactive")

    entry = VoterRollEntry(
        user_id=user.id,
        election_id=election.id,
        is_eligible=is_eligible,
        has_voted=False,
    )

    session.add(entry)

    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise InvalidRequest("user is already enrolled in this election") from error

    return VoterRollData(
        user_id=entry.user_id,
        election_id=str(election.id),
        is_eligible=entry.is_eligible,
        has_voted=entry.has_voted,
    )


def get_voter_roll(
    session: Session,
    *,
    election_id: str,
) -> list[VoterRollData]:
    """Devuelve los usuarios inscritos en una elección."""

    election = get_election(session, election_id)

    entries = session.scalars(
        select(VoterRollEntry)
        .where(VoterRollEntry.election_id == election.id)
        .order_by(VoterRollEntry.user_id)
    ).all()

    return [
        VoterRollData(
            user_id=entry.user_id,
            election_id=str(election.id),
            is_eligible=entry.is_eligible,
            has_voted=entry.has_voted,
        )
        for entry in entries
    ]


def update_voter_eligibility(
    session: Session,
    *,
    election_id: str,
    user_id: int,
    is_eligible: bool,
) -> VoterRollData:
    """Activa o desactiva la elegibilidad de un usuario."""

    election = get_election(session, election_id)

    entry = session.scalar(
        select(VoterRollEntry).where(
            VoterRollEntry.election_id == election.id,
            VoterRollEntry.user_id == user_id,
        )
    )

    if entry is None:
        raise InvalidRequest("user is not enrolled in this election")

    entry.is_eligible = is_eligible
    session.commit()

    return VoterRollData(
        user_id=entry.user_id,
        election_id=str(election.id),
        is_eligible=entry.is_eligible,
        has_voted=entry.has_voted,
    )

def confirm_vote(
    session: Session,
    *,
    election_id: str,
    user_id: int,
) -> VoterRollData:
    election = get_election(session, election_id)

    entry = session.scalar(
        select(VoterRollEntry).where(
            VoterRollEntry.election_id == election.id,
            VoterRollEntry.user_id == user_id,
        )
    )

    if entry is None:
        raise InvalidRequest("user is not enrolled in this election")

    if not entry.is_eligible:
        raise InvalidRequest("user is not eligible for this election")

    # La confirmación es idempotente: repetirla no causa problemas.
    if not entry.has_voted:
        entry.has_voted = True
        session.commit()

    return VoterRollData(
        user_id=entry.user_id,
        election_id=str(election.id),
        is_eligible=entry.is_eligible,
        has_voted=entry.has_voted,
    )