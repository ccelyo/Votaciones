"""Casos de uso del servicio Election (FA-03).

Cada operación que cambia el estado bloquea la fila de la elección (``SELECT ...
FOR UPDATE``), aplica las reglas de app/rules.py, registra la acción en
``election_audit`` y deja sus eventos en el outbox, todo en una sola transacción.
"""

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import events, parameters, rules
from app.encoding import b64url_encode
from app.errors import ElectionNotFound, UrnKeyUnavailable
from app.keys import PARAMETER_ALGORITHM, URN_ALGORITHM, ServiceKeys, private_key_pem
from app.models import (
    STATUS_CLOSED,
    STATUS_DRAFT,
    STATUS_OPEN,
    Election,
    ElectionAudit,
    ElectionOption,
    ElectionParameters,
    UrnKey,
)

SYSTEM_ACTOR = "system"
_UNSET = object()


def utcnow() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def parse_election_id(raw: str) -> int:
    if not raw.isascii() or not raw.isdigit() or not 0 < int(raw) < 2**31:
        raise ElectionNotFound()
    return int(raw)


def _audit(session: Session, election: Election, action: str, actor: str, now: datetime) -> None:
    session.add(ElectionAudit(election_id=election.id, action=action, actor=actor, occurred_at=now))


def _set_options(election: Election, options: list[str], blank_option: str | None) -> None:
    election.options = [
        ElectionOption(position=position, label=label, is_blank=label == blank_option)
        for position, label in enumerate(options)
    ]


# --- consultas ---------------------------------------------------------------


def get_election(session: Session, election_id: str, *, for_update: bool = False) -> Election:
    query = select(Election).where(Election.id == parse_election_id(election_id))
    if for_update:
        query = query.with_for_update()
    election = session.scalars(query).one_or_none()
    if election is None:
        raise ElectionNotFound()
    return election


def get_visible_election(session: Session, election_id: str, *, is_admin: bool) -> Election:
    """Los borradores solo existen para los administradores."""
    election = get_election(session, election_id)
    if election.status == STATUS_DRAFT and not is_admin:
        raise ElectionNotFound()
    return election


def list_elections(session: Session, *, status: str | None = None) -> list[Election]:
    query = select(Election).order_by(Election.id.desc())
    if status is not None:
        query = query.where(Election.status == status)
    return list(session.scalars(query).all())


def list_voting_elections(session: Session, now: datetime) -> list[Election]:
    """Elecciones que aceptan votos en este momento."""
    return list(
        session.scalars(
            select(Election)
            .where(
                Election.status == STATUS_OPEN,
                Election.opens_at <= now,
                Election.closes_at > now,
            )
            .order_by(Election.closes_at, Election.id)
        ).all()
    )


@dataclass(frozen=True)
class PublishedParameters:
    election: Election
    urn_key: UrnKey
    stored: ElectionParameters


def get_parameters(session: Session, election_id: str) -> PublishedParameters:
    election = get_election(session, election_id)
    urn_key = session.get(UrnKey, election.id)
    stored = session.get(ElectionParameters, election.id)
    if election.status == STATUS_DRAFT or urn_key is None or stored is None:
        raise ElectionNotFound("election has no published parameters")
    return PublishedParameters(election=election, urn_key=urn_key, stored=stored)


# --- administración ----------------------------------------------------------


def create_election(
    session: Session,
    *,
    actor: str,
    name: str,
    description: str,
    options: list[str],
    blank_option: str | None,
    opens_at: datetime,
    closes_at: datetime,
    now: datetime | None = None,
) -> Election:
    now = now or utcnow()
    name = rules.validate_name(name)
    description = rules.validate_description(description)
    options, blank_option = rules.validate_options(options, blank_option)
    rules.validate_window(opens_at, closes_at, now)

    election = Election(
        name=name,
        description=description,
        status=STATUS_DRAFT,
        opens_at=opens_at,
        closes_at=closes_at,
        created_by=actor,
        created_at=now,
        updated_at=now,
    )
    _set_options(election, options, blank_option)
    session.add(election)
    session.flush()
    _audit(session, election, "created", actor, now)
    session.commit()
    return election


def update_election(
    session: Session,
    election_id: str,
    *,
    actor: str,
    name=_UNSET,
    description=_UNSET,
    options=_UNSET,
    blank_option=_UNSET,
    opens_at=_UNSET,
    closes_at=_UNSET,
    now: datetime | None = None,
) -> Election:
    """Modifica un borrador. Los campos no enviados conservan su valor."""
    now = now or utcnow()
    election = get_election(session, election_id, for_update=True)
    rules.require_editable(election)

    new_name = election.name if name is _UNSET else rules.validate_name(name)
    new_description = (
        election.description if description is _UNSET else rules.validate_description(description)
    )
    new_options = election.option_labels if options is _UNSET else options
    new_blank = election.blank_option if blank_option is _UNSET else blank_option
    # Si cambian las opciones y el blanco anterior ya no está, se exige uno válido.
    new_options, new_blank = rules.validate_options(new_options, new_blank)
    new_opens = election.opens_at if opens_at is _UNSET else opens_at
    new_closes = election.closes_at if closes_at is _UNSET else closes_at
    rules.validate_window(new_opens, new_closes, now)

    election.name = new_name
    election.description = new_description
    election.opens_at = new_opens
    election.closes_at = new_closes
    if new_options != election.option_labels or new_blank != election.blank_option:
        election.options.clear()
        session.flush()  # borra las opciones viejas antes de reinsertar posiciones
        _set_options(election, new_options, new_blank)
    election.updated_at = now
    _audit(session, election, "updated", actor, now)
    session.commit()
    return election


def delete_election(session: Session, election_id: str) -> None:
    election = get_election(session, election_id, for_update=True)
    rules.require_editable(election)
    session.delete(election)
    session.commit()


def open_election(
    session: Session, keys: ServiceKeys, election_id: str, *, actor: str, now: datetime | None = None
) -> Election:
    """Publica la elección: genera la llave de la urna, firma los parámetros y
    emite ``election.created`` y ``election.opened``.

    Si ``opens_at`` ya pasó, la votación empieza ahora (se ajusta ``opens_at``).
    """
    now = now or utcnow()
    election = get_election(session, election_id, for_update=True)
    rules.require_can_open(election, now)
    if election.opens_at < now:
        election.opens_at = now

    urn = keys.generate_urn_key(election.ref)
    session.add(
        UrnKey(
            election_id=election.id,
            algorithm=URN_ALGORITHM,
            public_key_der=urn.public_key_der,
            wrapped_private_key=urn.wrapped_private_key,
            wrap_nonce=urn.wrap_nonce,
            kek_id=urn.kek_id,
            created_at=now,
        )
    )

    canonical = parameters.canonical_parameters(
        election_id=election.ref,
        name=election.name,
        options=election.option_labels,
        blank_option=election.blank_option,
        opens_at=election.opens_at,
        closes_at=election.closes_at,
        encryption_algorithm=URN_ALGORITHM,
        encryption_public_key=urn.public_key_der,
    )
    signature = parameters.sign(keys.parameter_private, canonical)
    stored = ElectionParameters(
        election_id=election.id,
        signed_parameters=canonical,
        signing_key_id=keys.parameter_key_id,
        signature_algorithm=PARAMETER_ALGORITHM,
        signature=signature,
        created_at=now,
    )
    session.add(stored)

    election.status = STATUS_OPEN
    election.opened_at = now
    election.updated_at = now
    _audit(session, election, "opened", actor, now)

    events.enqueue(
        session,
        events.ELECTION_CREATED,
        events.created_data(
            election,
            encryption=encryption_view(URN_ALGORITHM, urn.public_key_der),
            signed_parameters=b64url_encode(canonical),
            signature=signature_view(stored),
        ),
        occurred_at=now,
    )
    events.enqueue(session, events.ELECTION_OPENED, events.opened_data(election), occurred_at=now)
    session.commit()
    return election


def close_election(
    session: Session, election_id: str, *, actor: str, now: datetime | None = None
) -> Election:
    """Cierra la urna. Es idempotente: cerrar una urna cerrada no emite otro evento."""
    now = now or utcnow()
    election = get_election(session, election_id, for_update=True)
    rules.require_can_close(election)
    if election.status == STATUS_CLOSED:
        session.rollback()
        return election
    _close(session, election, actor=actor, closed_at=min(now, election.closes_at), reason="manual", now=now)
    session.commit()
    return election


def close_expired_elections(session: Session, *, now: datetime | None = None) -> list[str]:
    """Cierra las urnas abiertas cuya ventana ya terminó (``closed_at = closes_at``)."""
    now = now or utcnow()
    expired = session.scalars(
        select(Election)
        .where(Election.status == STATUS_OPEN, Election.closes_at <= now)
        .order_by(Election.id)
        .with_for_update(skip_locked=True)
    ).all()
    for election in expired:
        _close(session, election, actor=SYSTEM_ACTOR, closed_at=election.closes_at, reason="schedule", now=now)
    session.commit()
    return [election.ref for election in expired]


def _close(session: Session, election: Election, *, actor: str, closed_at: datetime, reason: str, now: datetime) -> None:
    election.status = STATUS_CLOSED
    election.closed_at = closed_at
    election.updated_at = now
    _audit(session, election, "closed", actor, now)
    events.enqueue(session, events.ELECTION_CLOSED, events.closed_data(election, reason), occurred_at=now)


def release_urn_private_key(
    session: Session, keys: ServiceKeys, election_id: str, *, actor: str, now: datetime | None = None
) -> tuple[Election, UrnKey, str]:
    """Entrega la llave privada de una urna cerrada para el escrutinio (Tally).

    Cada entrega queda en ``election_audit`` y en ``urn_keys.release_count``.
    """
    now = now or utcnow()
    election = get_election(session, election_id, for_update=True)
    rules.require_closed(election)
    urn_key = session.get(UrnKey, election.id)
    if urn_key is None:
        raise UrnKeyUnavailable("this election has no urn key")
    try:
        private = keys.unwrap_urn_key(
            election.ref, urn_key.wrapped_private_key, urn_key.wrap_nonce, urn_key.kek_id
        )
    except Exception as error:
        raise UrnKeyUnavailable("the urn key cannot be unwrapped with the configured master key") from error

    urn_key.released_at = now
    urn_key.release_count += 1
    _audit(session, election, "urn_key_released", actor, now)
    session.commit()
    return election, urn_key, private_key_pem(private)


# --- vistas compartidas por la API y los eventos -----------------------------


def encryption_view(algorithm: str, public_key_der: bytes) -> dict:
    return {
        "algorithm": algorithm,
        "public_key": b64url_encode(public_key_der),
        "public_key_format": "spki-der",
    }


def signature_view(stored: ElectionParameters) -> dict:
    return {
        "key_id": stored.signing_key_id,
        "algorithm": stored.signature_algorithm,
        "value": b64url_encode(stored.signature),
    }
