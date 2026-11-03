"""Operaciones HTTP, permisos y reglas del ciclo de vida (FA-04, FA-05, FA-07)."""

import base64
import time

import jwt

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from app import parameters
from app.encoding import b64url_decode
from tests.conftest import ADMIN, JWT_SECRET, VOTER, bearer, election_body, iso_in


# --- creación y validación -----------------------------------------------------


def test_create_returns_a_draft(client, create):
    created = create()
    assert created["election_id"].isdigit()
    assert created["status"] == "draft"
    assert created["phase"] == "draft"
    assert created["options"] == ["Candidata A", "Candidato B", "Voto en blanco"]
    assert created["blank_option"] == "Voto en blanco"
    assert created["opens_at"].endswith("Z")


def test_create_requires_admin(client):
    assert client.post("/elections", json=election_body()).status_code == 401
    response = client.post("/elections", json=election_body(), headers=VOTER)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_create_rejects_invalid_rules(client):
    cases = [
        election_body(options=["Solo una"], blank_option=None),
        election_body(options=["A", "A"], blank_option=None),
        election_body(options=[" A", "B"], blank_option=None),
        election_body(blank_option="No existe"),
        election_body(name=""),
        election_body(opens_at=iso_in(hours=2), closes_at=iso_in(hours=1)),
        election_body(opens_at=iso_in(minutes=1), closes_at=iso_in(minutes=3)),
        election_body(opens_at=iso_in(days=1), closes_at=iso_in(days=40)),
        election_body(opens_at=iso_in(hours=-3), closes_at=iso_in(hours=-1)),
    ]
    for body in cases:
        response = client.post("/elections", json=body, headers=ADMIN)
        assert response.status_code == 400, (body, response.text)
        assert response.json()["error"]["code"] == "invalid_request"


def test_create_rejects_dates_without_time_zone_and_unknown_fields(client):
    response = client.post(
        "/elections", json=election_body(opens_at="2030-01-01T10:00:00"), headers=ADMIN
    )
    assert response.status_code == 422
    response = client.post("/elections", json=election_body(extra="x"), headers=ADMIN)
    assert response.status_code == 422


# --- consulta y permisos ---------------------------------------------------------


def test_drafts_are_hidden_from_voters(client, create):
    election_id = create()["election_id"]
    assert client.get(f"/elections/{election_id}", headers=ADMIN).status_code == 200
    assert client.get(f"/elections/{election_id}", headers=VOTER).status_code == 404
    assert client.get(f"/elections/{election_id}/parameters", headers=VOTER).status_code == 404
    assert client.get("/elections/open").json() == []


def test_list_elections_is_admin_only_and_filters_by_status(client, create):
    first = create()["election_id"]
    second = create(name="Otra")["election_id"]
    client.post(f"/elections/{second}/open", headers=ADMIN)

    assert client.get("/elections", headers=VOTER).status_code == 403
    ids = [item["election_id"] for item in client.get("/elections", headers=ADMIN).json()]
    assert ids == [second, first]
    drafts = client.get("/elections?status=draft", headers=ADMIN).json()
    assert [item["election_id"] for item in drafts] == [first]


def test_unknown_or_malformed_ids_return_404(client):
    for election_id in ("999", "abc", "-1", "0", "1e3"):
        response = client.get(f"/elections/{election_id}", headers=ADMIN)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "election_not_found"


def test_jwt_authentication(client, create):
    assert client.post("/elections", json=election_body(), headers=bearer()).status_code == 201
    voter = bearer(sub="42", roles=["voter"])
    assert client.post("/elections", json=election_body(), headers=voter).status_code == 403
    # `role` como texto también se acepta (contrato del Gateway).
    token = jwt.encode({"sub": 7, "role": "admin", "exp": int(time.time()) + 60}, JWT_SECRET)
    assert client.get("/elections", headers={"Authorization": f"Bearer {token}"}).status_code == 200


def test_invalid_or_expired_jwt_is_rejected(client):
    expired = bearer(exp=1)
    assert client.get("/elections", headers=expired).status_code == 401
    forged = {"Authorization": "Bearer " + bearer()["Authorization"].split()[1][:-4] + "AAAA"}
    assert client.get("/elections", headers=forged).status_code == 401
    unsigned_header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    none_token = f"{unsigned_header}.e30."
    assert client.get("/elections", headers={"Authorization": f"Bearer {none_token}"}).status_code == 401


# --- actualización y borrado ---------------------------------------------------------


def test_update_draft(client, create):
    election_id = create()["election_id"]
    response = client.patch(
        f"/elections/{election_id}",
        json={"name": "Nuevo nombre", "options": ["X", "Y"], "blank_option": None},
        headers=ADMIN,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Nuevo nombre"
    assert body["options"] == ["X", "Y"]
    assert body["blank_option"] is None
    assert body["description"] == "Representante estudiantil"


def test_update_rejects_removing_the_current_blank_option(client, create):
    election_id = create()["election_id"]
    response = client.patch(f"/elections/{election_id}", json={"options": ["X", "Y"]}, headers=ADMIN)
    assert response.status_code == 400


def test_update_and_delete_only_in_draft(client, create):
    election_id = create()["election_id"]
    client.post(f"/elections/{election_id}/open", headers=ADMIN)
    response = client.patch(f"/elections/{election_id}", json={"name": "X"}, headers=ADMIN)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "invalid_state"
    assert client.delete(f"/elections/{election_id}", headers=ADMIN).status_code == 409


def test_delete_draft(client, create):
    election_id = create()["election_id"]
    assert client.delete(f"/elections/{election_id}", headers=ADMIN).status_code == 204
    assert client.get(f"/elections/{election_id}", headers=ADMIN).status_code == 404


# --- apertura, parámetros y cierre --------------------------------------------------


def test_open_publishes_signed_parameters(client, create):
    election_id = create()["election_id"]
    opened = client.post(f"/elections/{election_id}/open", headers=ADMIN)
    assert opened.status_code == 200, opened.text
    assert opened.json()["status"] == "open"
    assert opened.json()["phase"] == "voting"

    params = client.get(f"/elections/{election_id}/parameters", headers=VOTER).json()
    assert params["encryption"]["algorithm"] == "RSA-OAEP-256+A256GCM"
    public_key = serialization.load_der_public_key(b64url_decode(params["encryption"]["public_key"]))
    assert public_key.key_size == 2048

    keys = client.get("/keys").json()["parameter_signing"]
    assert params["signature"]["key_id"] == keys["key_id"]
    verifier = ed25519.Ed25519PublicKey.from_public_bytes(b64url_decode(keys["public_key"]))
    signed = b64url_decode(params["signed_parameters"])
    assert parameters.verify(verifier, signed, b64url_decode(params["signature"]["value"]))
    assert b'"election_id":"%s"' % election_id.encode() in signed

    listed = client.get("/elections/open").json()
    assert [item["election_id"] for item in listed] == [election_id]


def test_open_future_election_is_scheduled(client, create):
    election_id = create(opens_at=iso_in(hours=1), closes_at=iso_in(hours=3))["election_id"]
    body = client.post(f"/elections/{election_id}/open", headers=ADMIN).json()
    assert body["phase"] == "scheduled"
    assert client.get("/elections/open").json() == []
    status = client.get(f"/elections/{election_id}/status", headers=ADMIN).json()
    assert status["accepts_ballots"] is False


def test_open_twice_is_rejected(client, create):
    election_id = create()["election_id"]
    assert client.post(f"/elections/{election_id}/open", headers=ADMIN).status_code == 200
    assert client.post(f"/elections/{election_id}/open", headers=ADMIN).status_code == 409


def test_close_is_idempotent_and_irreversible(client, create):
    election_id = create()["election_id"]
    assert client.post(f"/elections/{election_id}/close", headers=ADMIN).status_code == 409  # draft
    client.post(f"/elections/{election_id}/open", headers=ADMIN)

    first = client.post(f"/elections/{election_id}/close", headers=ADMIN)
    second = client.post(f"/elections/{election_id}/close", headers=ADMIN)
    assert first.status_code == second.status_code == 200
    assert first.json()["closed_at"] == second.json()["closed_at"]
    assert client.post(f"/elections/{election_id}/open", headers=ADMIN).status_code == 409
    status = client.get(f"/elections/{election_id}/status", headers=ADMIN).json()
    assert status["status"] == "closed"
    assert status["accepts_ballots"] is False


def test_close_and_open_require_admin(client, create):
    election_id = create()["election_id"]
    assert client.post(f"/elections/{election_id}/open", headers=VOTER).status_code == 403
    assert client.post(f"/elections/{election_id}/close", headers=VOTER).status_code == 403


def test_health_and_ready(client):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").json()["database"] is True
