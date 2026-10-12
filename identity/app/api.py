"""API HTTP del servicio de identidad (REST/JSON).

Endpoints de mi frente (M6); ``/login`` y la confirmación de voto son de M5/M1:

* ``POST /elections``                       admin: crea y registra la urna en ballot
* ``POST /elections/{id}/close``            admin: cierra la urna (irreversible)
* ``GET  /elections/{id}/status``           admin: estado y participación
* ``GET  /elections/{id}/parameters``       sesión: parámetros firmados para el navegador
* ``GET  /keys``                            público: claves públicas de identidad
* ``POST /tokens/blind``                    votante autenticado: firma ciega del token

``{id}`` es el texto de ``elections.id`` (p. ej. ``"1"``): el mismo valor que
`ballot` recibe como ``election_id`` y que va dentro del token.
"""

from collections.abc import Iterator
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request, Response, status as http_status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import elections as election_service
from app import tokens as token_service
from app.auth import Principal, bearer_scheme, get_principal, require_admin
from app.ballot_client import BallotGateway
from app.encoding import b64url_decode, b64url_encode
from app.keys import IdentityKeys

from app.login import authenticate_user

import secrets

from app.errors import Unauthenticated
from app.sessions import (
    complete_mfa_challenge,
    create_mfa_challenge,
    revoke_session,
)

from app import voter_roll as voter_roll_service
from app.models import STATUS_OPEN, Election, Role, User

router = APIRouter()


# --- dependencias -----------------------------------------------------------


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        yield session


def get_ballot(request: Request) -> BallotGateway:
    return request.app.state.ballot


def get_keys(request: Request) -> IdentityKeys:
    return request.app.state.keys


# --- esquemas ---------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")

class LoginRequest(_Strict):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=128)    

class MFARequest(_Strict):
    challenge_id: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=6, max_length=6)

class VoteConfirmationRequest(_Strict):
    election_id: str = Field(min_length=1, max_length=128)

class EnrollVoterRequest(_Strict):
    user_id: int = Field(gt=0)
    is_eligible: bool = True


class UpdateEligibilityRequest(_Strict):
    is_eligible: bool


class CreateElectionRequest(_Strict):
    name: str = Field(max_length=150)
    options: list[str] = Field(max_length=100)
    encryption_public_key: str = Field(description="Clave pública de la elección, base64url")
    opens_at: int = Field(description="Epoch en segundos UTC")
    closes_at: int = Field(description="Epoch en segundos UTC")


class BlindTokenRequest(_Strict):
    election_id: str = Field(max_length=128)
    blinded_token: str = Field(max_length=4096, description="Mensaje cegado, base64url")


# --- autenticación ----------------------------------------------------------


@router.post("/login")
def login(
    body: LoginRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    principal = authenticate_user(
        session,
        username=body.username,
        password=body.password,
    )

    challenge_id = create_mfa_challenge(
        session,
        principal,
        ttl_seconds=request.app.state.settings.mfa_challenge_ttl_seconds,
    )

    return {
        "mfa_required": True,
        "challenge_id": challenge_id,
    }


@router.post("/login/mfa")
def verify_mfa(
    body: MFARequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    settings = request.app.state.settings

    if not secrets.compare_digest(body.code, settings.mfa_code):
        raise Unauthenticated("invalid MFA code")

    token = complete_mfa_challenge(
        session,
        body.challenge_id,
        session_ttl_seconds=settings.session_ttl_seconds,
    )

    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": settings.session_ttl_seconds,
    }


@router.get("/auth/me")
def current_user(
    principal: Principal = Depends(get_principal),
    session: Session = Depends(get_session),
) -> dict:
    result = session.execute(
        select(User, Role.name)
        .join(Role, User.role_id == Role.id)
        .where(User.id == principal.user_id)
    ).first()
    if result is None:
        raise Unauthenticated("authenticated user not found")

    user, role_name = result
    return {
        "id": user.id,
        "username": user.username,
        "role": role_name,
    }


@router.post("/logout", status_code=http_status.HTTP_204_NO_CONTENT)
def logout(
    principal: Principal = Depends(get_principal),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    session: Session = Depends(get_session),
) -> Response:
    if credentials is None:
        raise Unauthenticated("authentication required")
    revoke_session(session, credentials.credentials)
    return Response(status_code=http_status.HTTP_204_NO_CONTENT)


# --- votante ----------------------------------------------------------------


@router.post("/tokens/blind")
def blind_token(
    body: BlindTokenRequest,
    principal: Principal = Depends(get_principal),
    session: Session = Depends(get_session),
    keys: IdentityKeys = Depends(get_keys),
) -> dict:
    result = token_service.issue_blind_signature(
        session,
        keys,
        user_id=principal.user_id,
        election_id=body.election_id,
        blinded_message=b64url_decode(body.blinded_token, "blinded_token"),
    )
    return {
        "kid": result.kid,
        "variant": result.variant,
        "blind_signature": b64url_encode(result.blind_signature),
    }


@router.get("/elections/{election_id}/parameters")
def election_parameters(
    election_id: str,
    _: Principal = Depends(get_principal),
    session: Session = Depends(get_session),
) -> dict:
    election, stored = election_service.get_parameters(session, election_id)
    return {
        "election_id": election_service.election_ref(election),
        "name": election.name,
        "options": stored.options,
        "encryption_public_key": b64url_encode(stored.encryption_public_key),
        "opens_at": election_service.to_epoch(election.starts_at),
        "closes_at": election_service.to_epoch(election.ends_at),
        # Clave RSA (SPKI DER) con la que el navegador cega y verifica el token.
        "token_key": {
            "kid": stored.token_kid,
            "public_key_der": b64url_encode(stored.token_public_key_der),
            "variant": stored.token_variant,
        },
        # El navegador debe verificar `signature` sobre estos bytes exactos.
        "signed_parameters": b64url_encode(stored.signed_parameters),
        "signature": {
            "key_id": stored.parameter_signing_key_id,
            "algorithm": stored.parameter_signature_algorithm,
            "value": b64url_encode(stored.parameter_signature),
        },
    }


# --- público ----------------------------------------------------------------


@router.get("/elections/open")
def list_open_elections(
    session: Session = Depends(get_session),
) -> list[dict]:
    now = datetime.now(UTC).replace(tzinfo=None)
    elections = session.scalars(
        select(Election)
        .where(
            Election.status == STATUS_OPEN,
            Election.starts_at <= now,
            Election.ends_at > now,
        )
        .order_by(Election.starts_at, Election.id)
    ).all()
    return [
        {
            "id": election.id,
            "name": election.name,
            "starts_at": election.starts_at.replace(tzinfo=UTC).isoformat(),
            "ends_at": election.ends_at.replace(tzinfo=UTC).isoformat(),
            "created_at": election.created_at.replace(tzinfo=UTC).isoformat(),
        }
        for election in elections
    ]


@router.get("/keys")
def public_keys(keys: IdentityKeys = Depends(get_keys)) -> dict:
    return {
        "token_signing": {
            "kid": keys.token_kid,
            "public_key_der": b64url_encode(keys.token_public_der),
        },
        "parameter_signing": {
            "key_id": keys.parameter_key_id,
            "algorithm": "Ed25519",
            "public_key": b64url_encode(keys.parameter_public_raw),
        },
    }


# --- administración ---------------------------------------------------------


@router.post("/elections", status_code=201)
def create_election(
    body: CreateElectionRequest,
    _: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
    ballot: BallotGateway = Depends(get_ballot),
    keys: IdentityKeys = Depends(get_keys),
) -> dict:
    election = election_service.create_election(
        session,
        ballot,
        keys,
        name=body.name,
        options=body.options,
        encryption_public_key=b64url_decode(body.encryption_public_key, "encryption_public_key"),
        opens_at=body.opens_at,
        closes_at=body.closes_at,
    )
    return {"election_id": election_service.election_ref(election), "status": election.status}


@router.post("/elections/{election_id}/close")
def close_election(
    election_id: str,
    _: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
    ballot: BallotGateway = Depends(get_ballot),
) -> dict:
    election = election_service.close_election(session, ballot, election_id)
    return {"election_id": election_service.election_ref(election), "status": election.status}


@router.get("/elections/{election_id}/status")
def status(
    election_id: str,
    _: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
    ballot: BallotGateway = Depends(get_ballot),
) -> dict:
    result = election_service.election_status(session, ballot, election_id)
    return {
        "election_id": result.election_id,
        "identity_status": result.identity_status,
        "ballot_status": result.ballot_status,
        "total_ballots": result.total_ballots,
    }

# --- padrón electoral -------------------------------------------------------


@router.post("/elections/{election_id}/voters", status_code=201)
def enroll_voter(
    election_id: str,
    body: EnrollVoterRequest,
    _: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    entry = voter_roll_service.enroll_voter(
        session,
        election_id=election_id,
        user_id=body.user_id,
        is_eligible=body.is_eligible,
    )

    return {
        "user_id": entry.user_id,
        "election_id": entry.election_id,
        "is_eligible": entry.is_eligible,
        "has_voted": entry.has_voted,
    }


@router.get("/elections/{election_id}/voters")
def list_voters(
    election_id: str,
    _: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
) -> list[dict]:
    entries = voter_roll_service.get_voter_roll(
        session,
        election_id=election_id,
    )

    return [
        {
            "user_id": entry.user_id,
            "election_id": entry.election_id,
            "is_eligible": entry.is_eligible,
            "has_voted": entry.has_voted,
        }
        for entry in entries
    ]


@router.patch("/elections/{election_id}/voters/{user_id}")
def update_voter(
    election_id: str,
    user_id: int,
    body: UpdateEligibilityRequest,
    _: Principal = Depends(require_admin),
    session: Session = Depends(get_session),
) -> dict:
    entry = voter_roll_service.update_voter_eligibility(
        session,
        election_id=election_id,
        user_id=user_id,
        is_eligible=body.is_eligible,
    )

    return {
        "user_id": entry.user_id,
        "election_id": entry.election_id,
        "is_eligible": entry.is_eligible,
        "has_voted": entry.has_voted,
    }

#----- confirmación de voto -------------------------------------------------------cd 
@router.post("/vote-confirmation")
def confirm_vote(
    body: VoteConfirmationRequest,
    principal: Principal = Depends(get_principal),
    session: Session = Depends(get_session),
) -> dict:
    entry = voter_roll_service.confirm_vote(
        session,
        election_id=body.election_id,
        user_id=principal.user_id,
    )

    return {
        "election_id": entry.election_id,
        "has_voted": entry.has_voted,
    }

@router.get("/")
def root() -> dict:
    return {"message": "Identity service running"}


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}
