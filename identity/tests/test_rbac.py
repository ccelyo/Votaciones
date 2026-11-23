"""RBAC (escenario 5 del Prototipo 3): permisos explícitos por rol en identidad.

Estas pruebas no usan las cabeceras ``X-Dev-*``: la app corre con ``dev_auth=False`` y
cada actor obtiene un JWT RS256 real con login + MFA. Así se ejercitan la firma, la
sesión en la base de datos, el rol leído de la base y el permiso, igual que en
despliegue.
"""

from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.serialization import load_der_public_key
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.api import router
from app.core.config import Settings
from app.core.encoding import b64url_decode, b64url_encode
from app.core.permissions import (
    ROLE_PERMISSIONS,
    ROLES,
    Permission,
    has_permission,
    permissions_for,
)
from app.db.census import IssuedCredential, VoterRollEntry
from app.db.models import STATUS_OPEN, Election, User
from app.main import create_app
from tests import rsabssa_client
from tests.test_jwt import bearer, create_user, log_in

PUBLIC = "public"
SESSION = "session"  # autenticado, sin permiso adicional (opera sobre su propia sesión)


# --- fixtures ---------------------------------------------------------------


@pytest.fixture
def strict_client(session_factory, ballot, keys, signer):
    """Identidad tal como se despliega: sin autenticación de desarrollo."""
    app = create_app(
        Settings(dev_auth=False),
        session_factory=session_factory,
        census_session_factory=session_factory,
        ballot=ballot,
        blind_signer=signer,
        keys=keys,
    )
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def actors(strict_client, session_factory, election_payload):
    """Un admin y un votante con sesión real, y una urna abierta creada por el admin."""
    admin_id = create_user(session_factory, username="admin_rbac", role="admin")
    voter_id = create_user(session_factory, username="votante_rbac", role="voter")
    admin = bearer(log_in(strict_client, "admin_rbac")["access_token"])
    voter = bearer(log_in(strict_client, "votante_rbac")["access_token"])

    created = strict_client.post("/elections", json=election_payload, headers=admin)
    assert created.status_code == 201, created.text

    return SimpleNamespace(
        admin=admin,
        voter=voter,
        admin_id=admin_id,
        voter_id=voter_id,
        election_id=created.json()["election_id"],
    )


# Operaciones de administración: (método, ruta, cuerpo). `{e}` = urna, `{a}`/`{v}` = ids.
ADMIN_OPERATIONS = [
    ("GET", "/users", None),
    ("POST", "/users", {"username": "colado1", "password": "segura123", "role": "admin"}),
    ("PATCH", "/users/{a}", {"is_active": False}),
    ("GET", "/elections", None),
    ("POST", "/elections", "payload"),
    ("POST", "/elections/{e}/open", None),
    ("POST", "/elections/{e}/close", None),
    ("GET", "/elections/{e}/status", None),
    ("GET", "/elections/{e}/voters", None),
    ("POST", "/elections/{e}/voters", {"user_id": "{v}"}),
    ("PATCH", "/elections/{e}/voters/{v}", {"is_eligible": False}),
]

VOTER_OPERATIONS = [
    ("GET", "/elections/{e}/parameters", None),
    ("GET", "/elections/{e}/eligibility", None),
    ("POST", "/tokens/blind", {"election_id": "{e}", "blinded_token": b64url_encode(b"\x01" * 256)}),
    ("POST", "/vote-confirmation", {"election_id": "{e}"}),
]


def _ids(operations):
    return [f"{method} {path}" for method, path, _ in operations]


def call(client, actors, election_payload, method, path, body, headers=None):
    ids = {"e": actors.election_id, "a": actors.admin_id, "v": actors.voter_id}
    url = path.format(**ids)
    if body == "payload":
        body = election_payload
    elif isinstance(body, dict):
        body = {
            key: (
                int(value.format(**ids)) if value == "{v}"
                else value.format(**ids) if isinstance(value, str) and "{" in value
                else value
            )
            for key, value in body.items()
        }
    return client.request(method, url, json=body, headers=headers or {})


# --- catálogo ---------------------------------------------------------------


def test_catalog_only_knows_the_existing_roles():
    assert ROLES == ("admin", "voter")
    assert set(ROLE_PERMISSIONS) == {"admin", "voter"}


def test_voter_only_participates_and_admin_administers():
    administrative = set(Permission) - {Permission.VOTING_PARTICIPATE}
    assert permissions_for(["voter"]) == {Permission.VOTING_PARTICIPATE}
    assert administrative <= permissions_for(["admin"])
    assert not any(has_permission(["voter"], permission) for permission in administrative)


@pytest.mark.parametrize("roles", [[], ["auditor"], ["ADMIN"], ["admin "], [""], ["root", "superuser"]])
def test_unknown_roles_get_no_permissions(roles):
    assert permissions_for(roles) == frozenset()
    assert not any(has_permission(roles, permission) for permission in Permission)


# --- toda ruta está clasificada y protegida -----------------------------------

EXPECTED_ACCESS = {
    ("POST", "/login"): PUBLIC,
    ("POST", "/login/mfa"): PUBLIC,
    ("GET", "/elections/open"): PUBLIC,
    ("GET", "/.well-known/jwks.json"): PUBLIC,
    ("GET", "/keys"): PUBLIC,
    ("GET", "/"): PUBLIC,
    ("GET", "/health"): PUBLIC,
    ("GET", "/auth/me"): SESSION,
    ("POST", "/logout"): SESSION,
    ("GET", "/users"): Permission.USERS_READ,
    ("POST", "/users"): Permission.USERS_WRITE,
    ("PATCH", "/users/{user_id}"): Permission.USERS_WRITE,
    ("GET", "/elections"): Permission.ELECTIONS_READ,
    ("GET", "/elections/{election_id}/status"): Permission.ELECTIONS_READ,
    ("POST", "/elections"): Permission.ELECTIONS_MANAGE,
    ("POST", "/elections/{election_id}/open"): Permission.ELECTIONS_MANAGE,
    ("POST", "/elections/{election_id}/close"): Permission.ELECTIONS_MANAGE,
    ("GET", "/elections/{election_id}/voters"): Permission.CENSUS_READ,
    ("POST", "/elections/{election_id}/voters"): Permission.CENSUS_WRITE,
    ("PATCH", "/elections/{election_id}/voters/{user_id}"): Permission.CENSUS_WRITE,
    ("GET", "/elections/{election_id}/parameters"): Permission.VOTING_PARTICIPATE,
    ("GET", "/elections/{election_id}/eligibility"): Permission.VOTING_PARTICIPATE,
    ("POST", "/tokens/blind"): Permission.VOTING_PARTICIPATE,
    ("POST", "/vote-confirmation"): Permission.VOTING_PARTICIPATE,
}

_BY_DEPENDENCY = {f"require_{permission.name.lower()}": permission for permission in Permission}


def _access_of(route: APIRoute):
    names = []
    pending = list(route.dependant.dependencies)
    while pending:
        dependant = pending.pop()
        names.append(getattr(dependant.call, "__name__", ""))
        pending.extend(dependant.dependencies)
    permissions = {_BY_DEPENDENCY[name] for name in names if name in _BY_DEPENDENCY}
    assert len(permissions) <= 1, route.path
    if permissions:
        return permissions.pop()
    return SESSION if "get_principal" in names else PUBLIC


def test_every_route_declares_the_expected_permission():
    """Matriz ruta → permiso. Una ruta nueva sin clasificar hace fallar esta prueba."""
    actual = {
        (method, route.path): _access_of(route)
        for route in router.routes  # el router que monta create_app
        if isinstance(route, APIRoute)
        for method in route.methods
    }
    assert actual == EXPECTED_ACCESS


# --- 401: sin sesión válida ---------------------------------------------------


@pytest.mark.parametrize(("method", "path", "body"), ADMIN_OPERATIONS + VOTER_OPERATIONS,
                         ids=_ids(ADMIN_OPERATIONS + VOTER_OPERATIONS))
def test_protected_routes_without_token_are_401(strict_client, actors, election_payload, method, path, body):
    response = call(strict_client, actors, election_payload, method, path, body)
    assert response.status_code == 401, response.text
    assert response.json()["error"]["code"] == "unauthenticated"


@pytest.mark.parametrize(
    "token",
    ["no-es-un-jwt", "a.b.c", "eyJhbGciOiJub25lIn0.e30."],
    ids=["texto", "segmentos-falsos", "alg-none"],
)
def test_invalid_token_is_401_on_census(strict_client, actors, token):
    path = f"/elections/{actors.election_id}/voters"
    assert strict_client.get(path, headers=bearer(token)).status_code == 401


def test_voter_token_forged_as_admin_is_401(strict_client, actors):
    """Cambiar el claim `role` rompe la firma RS256: no hay escalada de privilegios."""
    header, payload, signature = actors.voter["Authorization"].removeprefix("Bearer ").split(".")
    claims = b64url_decode(payload, "payload").replace(b'"role":"voter"', b'"role":"admin"')
    assert b'"role":"admin"' in claims
    forged = bearer(f"{header}.{b64url_encode(claims)}.{signature}")
    response = strict_client.get(f"/elections/{actors.election_id}/voters", headers=forged)
    assert response.status_code == 401


def test_revoked_admin_session_is_401_on_admin_routes(strict_client, actors):
    assert strict_client.post("/logout", headers=actors.admin).status_code == 204
    response = strict_client.get(f"/elections/{actors.election_id}/voters", headers=actors.admin)
    assert response.status_code == 401


def test_dev_headers_are_ignored_when_dev_auth_is_off(strict_client, actors):
    spoofed = {"X-Dev-User": str(actors.admin_id), "X-Dev-Roles": "admin"}
    assert strict_client.get(f"/elections/{actors.election_id}/voters", headers=spoofed).status_code == 401


# --- 403: autenticado sin permiso ---------------------------------------------


@pytest.mark.parametrize(("method", "path", "body"), ADMIN_OPERATIONS, ids=_ids(ADMIN_OPERATIONS))
def test_voter_cannot_perform_administrative_operations(
    strict_client, actors, election_payload, method, path, body
):
    response = call(strict_client, actors, election_payload, method, path, body, actors.voter)
    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "forbidden"


def test_client_supplied_role_headers_do_not_grant_permissions(
    strict_client, client, actors, session_factory
):
    """Ni `X-User-Roles` (cabecera del Gateway) ni `X-Dev-Roles` cambian el rol: sale de la BD."""
    path = f"/elections/{actors.election_id}/voters"
    spoof = {"X-User-Roles": "admin", "X-User-Id": str(actors.admin_id)}
    assert strict_client.get(path, headers=actors.voter | spoof).status_code == 403

    # Incluso con dev_auth activo, un Bearer presente manda sobre X-Dev-Roles.
    create_user(session_factory, username="votante_dev", role="voter")
    voter_token = bearer(log_in(client, "votante_dev")["access_token"])
    dev_spoof = {"X-Dev-User": str(actors.admin_id), "X-Dev-Roles": "admin"}
    assert client.get(path, headers=voter_token | dev_spoof).status_code == 403


def test_unknown_role_is_denied_everywhere_but_its_own_session(
    strict_client, actors, session_factory
):
    # Un rol creado fuera de la API (p. ej. por SQL) y ausente del catálogo.
    create_user(session_factory, username="intruso", role="auditor")
    token = bearer(log_in(strict_client, "intruso")["access_token"])
    election = actors.election_id

    assert strict_client.get("/auth/me", headers=token).json()["role"] == "auditor"
    assert strict_client.get("/users", headers=token).status_code == 403
    assert strict_client.get(f"/elections/{election}/voters", headers=token).status_code == 403
    assert strict_client.get(f"/elections/{election}/eligibility", headers=token).status_code == 403
    blind = {"election_id": election, "blinded_token": b64url_encode(b"\x01" * 256)}
    assert strict_client.post("/tokens/blind", json=blind, headers=token).status_code == 403


def test_unknown_dev_role_is_denied(client):
    """Con dev_auth (solo pruebas), un rol inventado tampoco recibe permisos."""
    headers = {"X-Dev-User": "7", "X-Dev-Roles": "superadmin"}
    assert client.get("/users", headers=headers).status_code == 403
    assert client.get("/elections", headers=headers).status_code == 403


def test_denied_modifications_leave_the_data_untouched(
    strict_client, actors, election_payload, session_factory, ballot
):
    """Escenario 5: el votante intenta modificar el padrón y otras entidades; nada cambia."""
    other_voter = create_user(session_factory, username="votante_otro", role="voter")
    enrolled = strict_client.post(
        f"/elections/{actors.election_id}/voters",
        json={"user_id": other_voter},
        headers=actors.admin,
    )
    assert enrolled.status_code == 201

    def snapshot():
        with session_factory() as session:
            return {
                "roll": session.execute(
                    select(VoterRollEntry.voter_id, VoterRollEntry.is_eligible, VoterRollEntry.has_voted)
                    .order_by(VoterRollEntry.voter_id)
                ).all(),
                "users": session.execute(select(User.id, User.username, User.is_active, User.role_id)
                                         .order_by(User.id)).all(),
                "elections": session.execute(select(Election.id, Election.status)).all(),
                "credentials": session.scalar(select(func.count()).select_from(IssuedCredential)),
            }

    before = snapshot()
    ballot_before = (set(ballot.closed), set(ballot.registrations))

    attempts = [
        ("POST", f"/elections/{actors.election_id}/voters", {"user_id": actors.voter_id}),
        ("PATCH", f"/elections/{actors.election_id}/voters/{other_voter}", {"is_eligible": False}),
        ("POST", "/users", {"username": "colado2", "password": "segura123", "role": "admin"}),
        ("PATCH", f"/users/{actors.admin_id}", {"is_active": False}),
        ("POST", f"/elections/{actors.election_id}/close", None),
        ("POST", "/elections", election_payload),
    ]
    for method, path, body in attempts:
        response = strict_client.request(method, path, json=body, headers=actors.voter)
        assert response.status_code == 403, (method, path, response.text)

    assert snapshot() == before
    # Ni el cierre ni la creación denegados llegaron a Ballot.
    assert (set(ballot.closed), set(ballot.registrations)) == ballot_before


# --- lo permitido sigue funcionando ---------------------------------------------


def test_admin_performs_its_operations(strict_client, actors, election_payload):
    election = actors.election_id
    admin = actors.admin

    assert strict_client.get("/users", headers=admin).status_code == 200
    created = strict_client.post(
        "/users", json={"username": "nuevo_votante", "password": "segura123"}, headers=admin
    )
    assert created.status_code == 201 and created.json()["role"] == "voter"
    assert strict_client.patch(
        f"/users/{created.json()['id']}", json={"is_active": False}, headers=admin
    ).status_code == 200

    assert strict_client.get("/elections", headers=admin).status_code == 200
    assert strict_client.get(f"/elections/{election}/status", headers=admin).status_code == 200
    assert strict_client.post(f"/elections/{election}/open", headers=admin).status_code == 200

    enrolled = strict_client.post(
        f"/elections/{election}/voters", json={"user_id": actors.voter_id}, headers=admin
    )
    assert enrolled.status_code == 201
    roll = strict_client.get(f"/elections/{election}/voters", headers=admin)
    assert [entry["user_id"] for entry in roll.json()] == [actors.voter_id]
    assert strict_client.patch(
        f"/elections/{election}/voters/{actors.voter_id}", json={"is_eligible": False}, headers=admin
    ).json()["is_eligible"] is False

    assert strict_client.post(f"/elections/{election}/close", headers=admin).json()["status"] == "closed"


def test_voter_completes_the_anonymous_flow_with_a_real_session(strict_client, actors, signer):
    """Flujo de voto sin cambios: el votante accede solo a lo suyo y obtiene su credencial."""
    election = actors.election_id
    voter = actors.voter
    assert strict_client.post(
        f"/elections/{election}/voters", json={"user_id": actors.voter_id}, headers=actors.admin
    ).status_code == 201

    assert strict_client.get("/auth/me", headers=voter).json()["role"] == "voter"
    eligibility = strict_client.get(f"/elections/{election}/eligibility", headers=voter).json()
    assert eligibility["is_eligible"] is True and eligibility["token_issued"] is False

    params = strict_client.get(f"/elections/{election}/parameters", headers=voter)
    assert params.status_code == 200
    public_key = load_der_public_key(b64url_decode(params.json()["token_key"]["public_key_der"]))
    _, prepared = rsabssa_client.new_prepared_token_message(election)
    blinded, inv = rsabssa_client.blind(public_key, prepared)

    signed = strict_client.post(
        "/tokens/blind",
        json={"election_id": election, "blinded_token": b64url_encode(blinded)},
        headers=voter,
    )
    assert signed.status_code == 200, signed.text
    signature = rsabssa_client.finalize(
        public_key, prepared, b64url_decode(signed.json()["blind_signature"]), inv
    )
    rsabssa_client.verify(public_key, prepared, signature)  # credencial anónima válida

    confirmed = strict_client.post("/vote-confirmation", json={"election_id": election}, headers=voter)
    assert confirmed.status_code == 200 and confirmed.json()["has_voted"] is True

    # La urna sigue abierta: nada del flujo de voto requirió permisos de administración.
    with strict_client.app.state.session_factory() as session:
        assert session.get(Election, int(election)).status == STATUS_OPEN
