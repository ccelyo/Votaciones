"""Emisión de la credencial anónima por firma ciega.

El navegador genera el token, lo ciega y lo envía. Identidad:

1. comprueba que la urna esté abierta y el votante figure en Census (``is_eligible``);
2. RESERVA la emisión en Census bajo ``UNIQUE(election_id, voter_id)`` (sin confirmar);
3. pide la firma a Blind Signature enviando SOLO ``election_id`` + mensaje cegado;
4. confirma la reserva. Si la firma falla se revierte y el votante conserva su derecho.

Identidad no guarda el mensaje cegado ni la firma devuelta, y Blind Signature no
recibe el identificador del votante: ninguno de los dos puede enlazar a la persona
con la papeleta que llegue a `ballot`.
"""

import time

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.clients.blind_signature import BlindSignature, BlindSigner
from app.core.errors import ElectionNotOpen, NotEligible, TokenAlreadyIssued
from app.db.census import IssuedCredential, VoterRollEntry
from app.services.elections import election_ref, get_election, is_open_for_tokens


def issue_blind_signature(
    session: Session,
    census: Session,
    signer: BlindSigner,
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
    reference = election_ref(election)
    voter_id = str(user_id)

    in_roll = census.scalar(
        select(VoterRollEntry.id).where(
            VoterRollEntry.election_id == reference,
            VoterRollEntry.voter_id == voter_id,
            VoterRollEntry.is_eligible.is_(True),
        )
    )
    if in_roll is None:
        raise NotEligible()

    # Reserva: el UNIQUE impide dos emisiones, incluso concurrentes.
    census.add(IssuedCredential(election_id=reference, voter_id=voter_id))
    try:
        census.flush()
    except IntegrityError as error:
        census.rollback()
        raise TokenAlreadyIssued() from error

    try:
        # Aquí NO viaja el voter_id: Blind Signature solo ve la elección y el mensaje cegado.
        signature = signer.sign(reference, blinded_message)
    except Exception:
        census.rollback()  # una firma fallida no consume el derecho a la credencial
        raise

    census.commit()
    return signature
