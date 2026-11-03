"""API HTTP del servicio Election (REST/JSON, FA-04).

| Método | Ruta                                   | Acceso   |
| ------ | -------------------------------------- | -------- |
| GET    | /health, /ready                        | público  |
| GET    | /keys                                  | público  |
| GET    | /elections/open                        | público  |
| GET    | /elections                             | admin    |
| POST   | /elections                             | admin    |
| GET    | /elections/{id}                        | usuario (borradores: admin) |
| PATCH  | /elections/{id}                        | admin    |
| DELETE | /elections/{id}                        | admin    |
| POST   | /elections/{id}/open                   | admin    |
| POST   | /elections/{id}/close                  | admin    |
| GET    | /elections/{id}/status                 | admin    |
| GET    | /elections/{id}/parameters             | usuario  |
| POST   | /elections/{id}/urn-key/private        | admin    |

``{id}`` es el texto de ``elections.id`` (p. ej. ``"7"``). Detalle en README.md.
"""

from collections.abc import Iterator
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import rules
from app import service as election_service
from app.auth import Principal, get_principal, require_admin
from app.encoding import b64url_encode, iso
from app.errors import InvalidRequest
from app.keys import PARAMETER_ALGORITHM, ServiceKeys
from app.models import Election

router = APIRouter()


# --- dependencias -----------------------------------------------------------


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        yield session


def get_keys(request: Request) -> ServiceKeys:
    return request.app.state.keys


def notify_relay(request: Request) -> None:
    relay = getattr(request.app.state, "relay", None)
    if relay is not None:
        relay.notify()


# --- esquemas ---------------------------------------------------------------


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("must include a time zone, e.g. 2026-11-20T13:00:00Z")
    return value


AwareDatetime = Annotated[datetime, AfterValidator(_aware)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateElectionRequest(_Strict):
    name: str = Field(max_length=rules.MAX_NAME)
    description: str = Field(default="", max_length=rules.MAX_DESCRIPTION)
    options: list[str] = Field(max_length=rules.MAX_OPTIONS)
    blank_option: str | None = None
    opens_at: AwareDatetime = Field(description="RFC 3339 con zona horaria")
    closes_at: AwareDatetime = Field(description="RFC 3339 con zona horaria")


class UpdateElectionRequest(_Strict):
    name: str | None = Field(default=None, max_length=rules.MAX_NAME)
    description: str | None = Field(default=None, max_length=rules.MAX_DESCRIPTION)
    options: list[str] | None = Field(default=None, max_length=rules.MAX_OPTIONS)
    blank_option: str | None = None
    opens_at: AwareDatetime | None = None
    closes_at: AwareDatetime | None = None


# --- vistas -----------------------------------------------------------------


def election_view(election: Election, now: datetime) -> dict:
    return {
        "election_id": election.ref,
        "name": election.name,
        "description": election.description,
        "status": election.status,
        "phase": rules.phase(election, now),
        "options": election.option_labels,
        "blank_option": election.blank_option,
        "opens_at": iso(election.opens_at),
        "closes_at": iso(election.closes_at),
        "opened_at": iso(election.opened_at),
        "closed_at": iso(election.closed_at),
        "created_at": iso(election.created_at),
        "updated_at": iso(election.updated_at),
    }


# --- salud y llaves públicas --------------------------------------------------


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


@router.get("/ready")
def ready(request: Request, response: Response, session: Session = Depends(get_session)) -> dict:
    try:
        session.execute(text("SELECT 1"))
        database = True
    except Exception:  # noqa: BLE001
        database = False
    relay = getattr(request.app.state, "relay", None)
    events = relay is not None and relay.healthy
    if not database:
        response.status_code = 503
    # Un broker caído no impide administrar elecciones: los eventos esperan en el outbox.
    return {"database": database, "events_published": events}


@router.get("/keys")
def public_keys(keys: ServiceKeys = Depends(get_keys)) -> dict:
    return {
        "parameter_signing": {
            "key_id": keys.parameter_key_id,
            "algorithm": PARAMETER_ALGORITHM,
            "public_key": b64url_encode(keys.parameter_public_raw),
        }
    }


# --- consultas ----------------------------------------------------------------


@router.get("/elections/open")
def list_open_elections(session: Session = Depends(get_session)) -> list[dict]:
    """Elecciones que aceptan votos ahora mismo (público)."""
    now = election_service.utcnow()
    return [election_view(e, now) for e in election_service.list_voting_elections(session, now)]


@router.get("/elections")
def list_elections(
    status: Literal["draft", "open", "closed"] | None = Query(default=None),
    _: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
) -> list[dict]:
    now = election_service.utcnow()
    return [election_view(e, now) for e in election_service.list_elections(session, status=status)]


@router.get("/elections/{election_id}")
def get_election(
    election_id: str,
    principal: Principal = Depends(get_principal),
    session: Session = Depends(get_session),
) -> dict:
    election = election_service.get_visible_election(
        session, election_id, is_admin=principal.is_admin
    )
    return election_view(election, election_service.utcnow())


@router.get("/elections/{election_id}/parameters")
def election_parameters(
    election_id: str,
    _: Principal = Depends(get_principal),
    session: Session = Depends(get_session),
) -> dict:
    published = election_service.get_parameters(session, election_id)
    election, urn_key, stored = published.election, published.urn_key, published.stored
    return {
        "election_id": election.ref,
        "name": election.name,
        "status": election.status,
        "phase": rules.phase(election, election_service.utcnow()),
        "options": election.option_labels,
        "blank_option": election.blank_option,
        "opens_at": iso(election.opens_at),
        "closes_at": iso(election.closes_at),
        # Llave pública de la urna: el cliente cifra el voto con ella.
        "encryption": election_service.encryption_view(urn_key.algorithm, urn_key.public_key_der),
        # El cliente debe verificar `signature` sobre estos bytes exactos (GET /keys).
        "signed_parameters": b64url_encode(stored.signed_parameters),
        "signature": election_service.signature_view(stored),
    }


@router.get("/elections/{election_id}/status")
def election_status(
    election_id: str,
    _: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    election = election_service.get_election(session, election_id)
    now = election_service.utcnow()
    return {
        "election_id": election.ref,
        "status": election.status,
        "phase": rules.phase(election, now),
        "accepts_ballots": rules.accepts_ballots(election, now),
        "opens_at": iso(election.opens_at),
        "closes_at": iso(election.closes_at),
        "opened_at": iso(election.opened_at),
        "closed_at": iso(election.closed_at),
    }


# --- administración -----------------------------------------------------------


@router.post("/elections", status_code=201)
def create_election(
    body: CreateElectionRequest,
    response: Response,
    principal: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    election = election_service.create_election(
        session,
        actor=principal.user_id,
        name=body.name,
        description=body.description,
        options=body.options,
        blank_option=body.blank_option,
        opens_at=body.opens_at,
        closes_at=body.closes_at,
    )
    response.headers["Location"] = f"/elections/{election.ref}"
    return election_view(election, election_service.utcnow())


@router.patch("/elections/{election_id}")
def update_election(
    election_id: str,
    body: UpdateElectionRequest,
    principal: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    changes = body.model_dump(exclude_unset=True)
    for field in ("name", "description", "options", "opens_at", "closes_at"):
        if field in changes and changes[field] is None:
            raise InvalidRequest(f"{field} cannot be null")
    election = election_service.update_election(
        session, election_id, actor=principal.user_id, **changes
    )
    return election_view(election, election_service.utcnow())


@router.delete("/elections/{election_id}", status_code=204)
def delete_election(
    election_id: str,
    _: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
) -> Response:
    election_service.delete_election(session, election_id)
    return Response(status_code=204)


@router.post("/elections/{election_id}/open")
def open_election(
    election_id: str,
    request: Request,
    principal: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
    keys: ServiceKeys = Depends(get_keys),
) -> dict:
    election = election_service.open_election(session, keys, election_id, actor=principal.user_id)
    notify_relay(request)
    return election_view(election, election_service.utcnow())


@router.post("/elections/{election_id}/close")
def close_election(
    election_id: str,
    request: Request,
    principal: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    election = election_service.close_election(session, election_id, actor=principal.user_id)
    notify_relay(request)
    return election_view(election, election_service.utcnow())


@router.post("/elections/{election_id}/urn-key/private")
def release_private_key(
    election_id: str,
    response: Response,
    principal: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
    keys: ServiceKeys = Depends(get_keys),
) -> dict:
    """Llave privada de la urna (PEM PKCS#8) para lanzar el escrutinio en Tally."""
    election, urn_key, pem = election_service.release_urn_private_key(
        session, keys, election_id, actor=principal.user_id
    )
    response.headers["Cache-Control"] = "no-store"
    return {
        "election_id": election.ref,
        "algorithm": urn_key.algorithm,
        "private_key": pem,
        "release_count": urn_key.release_count,
    }
