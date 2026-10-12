"""Emisión del token anónimo por firma ciega.

El navegador genera el token, lo ciega y lo envía. Identidad:

1. comprueba que la urna esté abierta y el usuario figure en el padrón (``is_eligible``);
2. firma el mensaje cegado (sin poder ver el token);
3. registra ``usuario -> recibió token`` bajo ``UNIQUE(user_id, election_id)``.

Identidad no guarda el mensaje cegado ni la firma devuelta, de modo que no puede
enlazar después al usuario con la papeleta que llegue a `ballot`.
"""

import time
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import blind_rsa
from app.elections import get_election, is_open_for_tokens
from app.errors import ElectionNotOpen, InvalidRequest, NotEligible, TokenAlreadyIssued
from app.keys import IdentityKeys
from app.models import IssuedToken, VoterRollEntry


@dataclass(frozen=True)
class BlindSignature:
    kid: str
    variant: str
    blind_signature: bytes


def issue_blind_signature(
    session: Session,
    keys: IdentityKeys,
    *,
    user_id: int,
    election_id: str,
    blinded_message: bytes,
    now: int | None = None,
) -> BlindSignature:
    now = int(time.time()) if now is None else now
    election = get_election(session, election_id)
    if not is_open_for_tokens(election, now):
        raise ElectionNotOpen()

    in_roll = session.scalar(
        select(VoterRollEntry.id).where(
            VoterRollEntry.user_id == user_id,
            VoterRollEntry.election_id == election.id,
            VoterRollEntry.is_eligible.is_(True),
        )
    )
    if in_roll is None:
        raise NotEligible()

    # Se firma antes de registrar: una entrada inválida no consume el derecho a token.
    try:
        signature = blind_rsa.blind_sign(keys.token_private, blinded_message)
    except blind_rsa.BlindSignError as error:
        raise InvalidRequest(str(error)) from error

    session.add(IssuedToken(user_id=user_id, election_id=election.id))
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise TokenAlreadyIssued() from error

    return BlindSignature(
        kid=keys.token_kid, variant=blind_rsa.VARIANT, blind_signature=signature
    )
