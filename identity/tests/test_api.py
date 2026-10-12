import json
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from sqlalchemy import inspect, select

from app import parameters
from app.encoding import b64url_decode, b64url_encode
from app.models import IssuedToken
from tests import rsabssa_client
from tests.conftest import ADMIN, voter


def create_election(client, payload, headers=ADMIN):
    return client.post("/elections", json=payload, headers=headers)


def request_token(client, election_id, headers, blinded: bytes | None = None):
    blinded = blinded if blinded is not None else b"\x01" * 256
    return client.post(
        "/tokens/blind",
        json={"election_id": election_id, "blinded_token": b64url_encode(blinded)},
        headers=headers,
    )


# --- urnas ------------------------------------------------------------------


def test_create_election_registers_signed_parameters_in_ballot(client, ballot, election_payload, keys):
    response = create_election(client, election_payload)
    assert response.status_code == 201
    assert response.json() == {"election_id": "elec-2026", "status": "open"}

    registration = ballot.registrations["elec-2026"]
    assert registration.options == ["Alpha", "Beta", "Blanco"]
    assert registration.opens_at == election_payload["opens_at"]
    assert registration.token_keys[0].kid == keys.token_kid
    assert registration.token_keys[0].signature_variant == "RSABSSA-SHA384-PSS-Randomized"
    assert registration.token_keys[0].public_key_der == keys.token_public_der

    # La firma de parámetros que recibió ballot verifica con la clave pública de identidad.
    public_key = ed25519.Ed25519PublicKey.from_public_bytes(keys.parameter_public_raw)
    assert parameters.verify_parameters(
        public_key, registration.signed_parameters, registration.parameter_signature
    )
    assert registration.parameter_signature_algorithm == "Ed25519"
    assert registration.parameter_signing_key_id == keys.parameter_key_id


def test_parameters_endpoint_is_public_and_verifiable(client, election_payload, keys):
    create_election(client, election_payload)

    response = client.get("/elections/elec-2026/parameters")  # sin cabeceras de sesión
    assert response.status_code == 200
    body = response.json()

    signed = b64url_decode(body["signed_parameters"])
    signature = b64url_decode(body["signature"]["value"])
    pub = client.get("/keys").json()["parameter_signing"]
    public_key = ed25519.Ed25519PublicKey.from_public_bytes(b64url_decode(pub["public_key"]))
    assert parameters.verify_parameters(public_key, signed, signature)

    # Los campos legibles coinciden con los bytes firmados.
    document = json.loads(signed)
    assert document["election_id"] == body["election_id"]
    assert document["options"] == body["options"]
    assert document["token_key"]["kid"] == body["token_key"]["kid"]
    assert "private" not in response.text.lower()


def test_tampered_parameters_fail_signature(client, election_payload, keys):
    create_election(client, election_payload)
    body = client.get("/elections/elec-2026/parameters").json()
    signed = bytearray(b64url_decode(body["signed_parameters"]))
    signed[-5] ^= 0x01
    public_key = ed25519.Ed25519PublicKey.from_public_bytes(keys.parameter_public_raw)
    assert not parameters.verify_parameters(
        public_key, bytes(signed), b64url_decode(body["signature"]["value"])
    )


def test_create_election_requires_admin(client, election_payload):
    assert client.post("/elections", json=election_payload).status_code == 401
    assert create_election(client, election_payload, voter("u1")).status_code == 403


def test_create_election_rejects_invalid_input(client, election_payload):
    cases = [
        {**election_payload, "options": ["solo una"]},
        {**election_payload, "options": ["A", "A"]},
        {**election_payload, "options": ["A", " B"]},
        {**election_payload, "election_id": "con espacios"},
        {**election_payload, "closes_at": election_payload["opens_at"]},
        {**election_payload, "closes_at": int(time.time()) - 5},
        {**election_payload, "encryption_public_key": "no es base64!"},
        {**election_payload, "encryption_public_key": b64url_encode(b"-----BEGIN PRIVATE KEY-----")},
        {**election_payload, "extra": "campo no permitido"},
    ]
    for payload in cases:
        assert create_election(client, payload).status_code in (400, 422), payload


def test_duplicate_election_is_conflict(client, election_payload):
    assert create_election(client, election_payload).status_code == 201
    response = create_election(client, election_payload)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "election_already_exists"


def test_ballot_failure_does_not_persist_election(client, ballot, election_payload):
    ballot.down = True
    response = create_election(client, election_payload)
    assert response.status_code == 502
    assert client.get("/elections/elec-2026/parameters").status_code == 404

    ballot.down = False  # El alta se puede reintentar con los mismos datos.
    assert create_election(client, election_payload).status_code == 201


def test_generated_election_id_when_omitted(client, election_payload):
    payload = {k: v for k, v in election_payload.items() if k != "election_id"}
    response = create_election(client, payload)
    assert response.status_code == 201
    assert len(response.json()["election_id"]) == 32


def test_close_and_status(client, ballot, election_payload):
    create_election(client, election_payload)
    ballot.ballots["elec-2026"] = 7

    status = client.get("/elections/elec-2026/status", headers=ADMIN).json()
    assert status == {
        "election_id": "elec-2026",
        "identity_status": "open",
        "ballot_status": "open",
        "total_ballots": 7,
    }

    assert client.post("/elections/elec-2026/close", headers=ADMIN).json()["status"] == "closed"
    assert "elec-2026" in ballot.closed
    # Repetir el cierre sigue siendo exitoso.
    assert client.post("/elections/elec-2026/close", headers=ADMIN).status_code == 200
    status = client.get("/elections/elec-2026/status", headers=ADMIN).json()
    assert status["identity_status"] == "closed" and status["ballot_status"] == "closed"


def test_close_unknown_election_is_404(client):
    assert client.post("/elections/nope/close", headers=ADMIN).status_code == 404


def test_status_and_close_require_admin(client, election_payload):
    create_election(client, election_payload)
    assert client.get("/elections/elec-2026/status", headers=voter("u1")).status_code == 403
    assert client.post("/elections/elec-2026/close", headers=voter("u1")).status_code == 403


# --- token anónimo ----------------------------------------------------------


def test_happy_path_blind_token_verifies_without_identity_seeing_it(
    client, election_payload, enroll, keys
):
    create_election(client, election_payload)
    enroll("u1", "elec-2026")

    # Navegador: descarga parámetros, genera y ciega el token.
    params = client.get("/elections/elec-2026/parameters").json()
    from cryptography.hazmat.primitives.serialization import load_der_public_key

    public_key = load_der_public_key(b64url_decode(params["token_key"]["public_key_der"]))
    nonce, prepared = rsabssa_client.new_prepared_token_message("elec-2026")
    blinded, inv = rsabssa_client.blind(public_key, prepared)

    response = request_token(client, "elec-2026", voter("u1"), blinded)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["kid"] == keys.token_kid == params["token_key"]["kid"]
    assert body["variant"] == "RSABSSA-SHA384-PSS-Randomized"

    # Navegador: desciega y obtiene una firma válida sobre el token original.
    signature = rsabssa_client.finalize(
        public_key, prepared, b64url_decode(body["blind_signature"]), inv
    )
    rsabssa_client.verify(public_key, prepared, signature)
    assert len(nonce) == 32


def test_second_token_for_same_user_and_election_is_rejected(client, election_payload, enroll):
    create_election(client, election_payload)
    enroll("u1", "elec-2026")

    assert request_token(client, "elec-2026", voter("u1")).status_code == 200
    response = request_token(client, "elec-2026", voter("u1"))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "token_already_issued"


def test_each_voter_gets_one_token(client, election_payload, enroll):
    create_election(client, election_payload)
    enroll("u1", "elec-2026")
    enroll("u2", "elec-2026")
    assert request_token(client, "elec-2026", voter("u1")).status_code == 200
    assert request_token(client, "elec-2026", voter("u2")).status_code == 200


def test_user_outside_voter_roll_gets_no_token(client, election_payload, session_factory):
    create_election(client, election_payload)
    response = request_token(client, "elec-2026", voter("intruder"))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "not_in_voter_roll"
    with session_factory() as session:
        assert session.scalars(select(IssuedToken)).all() == []


def test_requires_authentication(client, election_payload):
    create_election(client, election_payload)
    response = client.post(
        "/tokens/blind",
        json={"election_id": "elec-2026", "blinded_token": b64url_encode(b"\x01" * 256)},
    )
    assert response.status_code == 401


def test_unknown_election_is_404(client, enroll):
    assert request_token(client, "ghost", voter("u1")).status_code == 404


def test_closed_election_issues_no_tokens(client, election_payload, enroll):
    create_election(client, election_payload)
    enroll("u1", "elec-2026")
    client.post("/elections/elec-2026/close", headers=ADMIN)
    response = request_token(client, "elec-2026", voter("u1"))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "election_not_open"


def test_election_not_yet_open_issues_no_tokens(client, election_payload, enroll):
    now = int(time.time())
    future = {**election_payload, "opens_at": now + 600, "closes_at": now + 1200}
    create_election(client, future)
    enroll("u1", "elec-2026")
    assert request_token(client, "elec-2026", voter("u1")).status_code == 409


def test_invalid_blinded_message_does_not_consume_the_token(client, election_payload, enroll):
    create_election(client, election_payload)
    enroll("u1", "elec-2026")

    assert request_token(client, "elec-2026", voter("u1"), b"\x01" * 10).status_code == 400
    assert request_token(client, "elec-2026", voter("u1"), b"\xff" * 256).status_code == 400
    bad_encoding = client.post(
        "/tokens/blind",
        json={"election_id": "elec-2026", "blinded_token": "***"},
        headers=voter("u1"),
    )
    assert bad_encoding.status_code == 400
    assert request_token(client, "elec-2026", voter("u1")).status_code == 200


def test_identity_stores_no_link_between_user_and_token(client, election_payload, enroll, session_factory):
    create_election(client, election_payload)
    enroll("u1", "elec-2026")
    blinded = b"\x07" * 256
    signature = b64url_decode(request_token(client, "elec-2026", voter("u1"), blinded).json()["blind_signature"])

    columns = {c["name"] for c in inspect(session_factory.kw["bind"]).get_columns("issued_tokens")}
    assert columns == {"id", "user_id", "election_id", "kid", "issued_at"}
    with session_factory() as session:
        row = session.scalars(select(IssuedToken)).one()
        stored = json.dumps([row.user_id, row.election_id, row.kid]).encode()
        assert blinded not in stored and signature not in stored
        assert (row.user_id, row.election_id) == ("u1", "elec-2026")


def test_public_keys_endpoint_exposes_only_public_material(client, keys):
    body = client.get("/keys").json()
    assert body["token_signing"]["kid"] == keys.token_kid
    assert body["parameter_signing"]["key_id"] == keys.parameter_key_id
    private_pem = keys.token_private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    assert b"PRIVATE" not in client.get("/keys").content
    assert private_pem not in client.get("/keys").content


def test_dev_auth_disabled_by_default(session_factory, ballot, keys):
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app

    app = create_app(
        Settings(dev_auth=False), session_factory=session_factory, ballot=ballot, keys=keys
    )
    with TestClient(app) as strict_client:
        assert strict_client.post("/elections", json={}, headers=ADMIN).status_code == 401
