import json
import time
from datetime import UTC, datetime, timedelta

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.serialization import load_der_public_key
from sqlalchemy import inspect, select

from app import parameters
from app.encoding import b64url_decode, b64url_encode
from app.models import STATUS_CLOSED, STATUS_OPEN, Election, IssuedToken
from tests import rsabssa_client
from tests.conftest import ADMIN, voter


def create_election(client, payload, headers=ADMIN):
    return client.post("/elections", json=payload, headers=headers)


def create_ok(client, payload) -> str:
    response = create_election(client, payload)
    assert response.status_code == 201, response.text
    return response.json()["election_id"]


def request_token(client, election_id, headers, blinded: bytes | None = None):
    blinded = blinded if blinded is not None else b"\x01" * 256
    return client.post(
        "/tokens/blind",
        json={"election_id": election_id, "blinded_token": b64url_encode(blinded)},
        headers=headers,
    )


# --- urnas ------------------------------------------------------------------


def test_create_election_registers_signed_parameters_in_ballot(
    client, ballot, election_payload, keys
):
    response = create_election(client, election_payload)
    assert response.status_code == 201
    # El id lo asigna PostgreSQL; hacia fuera es su texto.
    assert response.json() == {"election_id": "1", "status": "open"}

    registration = ballot.registrations["1"]
    assert registration.options == ["Alpha", "Beta", "Blanco"]
    assert registration.opens_at == election_payload["opens_at"]
    assert registration.closes_at == election_payload["closes_at"]
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
    # El id dentro de los bytes firmados es el mismo texto que usa ballot.
    assert json.loads(registration.signed_parameters)["election_id"] == "1"


def test_election_is_stored_in_the_shared_schema_columns(client, session_factory, election_payload):
    create_ok(client, election_payload)
    with session_factory() as session:
        election = session.get(Election, 1)
        assert election.name == election_payload["name"]
        assert election.status == STATUS_OPEN
        # TIMESTAMP sin zona: UTC naive, convertible a epoch sin pérdida.
        assert int(election.starts_at.replace(tzinfo=UTC).timestamp()) == election_payload["opens_at"]
        assert int(election.ends_at.replace(tzinfo=UTC).timestamp()) == election_payload["closes_at"]


def test_parameters_endpoint_requires_session_and_is_verifiable(client, election_payload, new_user):
    election_id = create_ok(client, election_payload)
    path = f"/elections/{election_id}/parameters"
    assert client.get(path).status_code == 401  # sin sesión

    response = client.get(path, headers=voter(new_user()))
    assert response.status_code == 200
    body = response.json()
    assert body["election_id"] == election_id
    assert body["name"] == election_payload["name"]

    signed = b64url_decode(body["signed_parameters"])
    signature = b64url_decode(body["signature"]["value"])
    pub = client.get("/keys").json()["parameter_signing"]
    public_key = ed25519.Ed25519PublicKey.from_public_bytes(b64url_decode(pub["public_key"]))
    assert parameters.verify_parameters(public_key, signed, signature)

    # Los campos legibles coinciden con los bytes firmados.
    document = json.loads(signed)
    assert document["election_id"] == body["election_id"]
    assert document["name"] == body["name"]
    assert document["options"] == body["options"]
    assert document["opens_at"] == body["opens_at"] == election_payload["opens_at"]
    assert document["token_key"]["kid"] == body["token_key"]["kid"]
    assert "private" not in response.text.lower()


def test_tampered_parameters_fail_signature(client, election_payload, keys, new_user):
    election_id = create_ok(client, election_payload)
    body = client.get(f"/elections/{election_id}/parameters", headers=voter(new_user())).json()
    signed = bytearray(b64url_decode(body["signed_parameters"]))
    signed[-5] ^= 0x01
    public_key = ed25519.Ed25519PublicKey.from_public_bytes(keys.parameter_public_raw)
    assert not parameters.verify_parameters(
        public_key, bytes(signed), b64url_decode(body["signature"]["value"])
    )


def test_create_election_requires_admin(client, election_payload, new_user):
    assert client.post("/elections", json=election_payload).status_code == 401
    assert create_election(client, election_payload, voter(new_user())).status_code == 403


def test_list_open_elections_is_public_and_filters_by_current_window(
    client, election_payload, session_factory
):
    active_id = create_ok(client, election_payload)
    now = datetime.now(UTC).replace(tzinfo=None)

    with session_factory() as session:
        session.add_all(
            [
                Election(
                    name="Elección futura",
                    status=STATUS_OPEN,
                    starts_at=now + timedelta(hours=1),
                    ends_at=now + timedelta(hours=2),
                ),
                Election(
                    name="Elección finalizada",
                    status=STATUS_OPEN,
                    starts_at=now - timedelta(hours=2),
                    ends_at=now - timedelta(hours=1),
                ),
                Election(
                    name="Elección cerrada",
                    status=STATUS_CLOSED,
                    starts_at=now - timedelta(minutes=1),
                    ends_at=now + timedelta(hours=1),
                ),
            ]
        )
        session.commit()

    response = client.get("/elections/open")

    assert response.status_code == 200
    assert [election["id"] for election in response.json()] == [int(active_id)]
    assert response.json()[0]["name"] == election_payload["name"]
    assert response.json()[0]["starts_at"].endswith("+00:00")


def test_create_election_rejects_invalid_input(client, election_payload):
    cases = [
        {**election_payload, "name": ""},
        {**election_payload, "name": " con espacios "},
        {**election_payload, "name": "x" * 151},
        {**election_payload, "options": ["solo una"]},
        {**election_payload, "options": ["A", "A"]},
        {**election_payload, "options": ["A", " B"]},
        {**election_payload, "closes_at": election_payload["opens_at"]},
        {**election_payload, "closes_at": int(time.time()) - 5},
        {**election_payload, "encryption_public_key": "no es base64!"},
        {**election_payload, "encryption_public_key": b64url_encode(b"-----BEGIN PRIVATE KEY-----")},
        {**election_payload, "election_id": "7"},  # el id lo asigna PostgreSQL
        {**election_payload, "extra": "campo no permitido"},
    ]
    for payload in cases:
        assert create_election(client, payload).status_code in (400, 422), payload


def test_each_election_gets_its_own_sequential_id(client, election_payload):
    assert create_ok(client, election_payload) == "1"
    assert create_ok(client, election_payload) == "2"


def test_ballot_failure_does_not_persist_election(client, ballot, election_payload, session_factory):
    ballot.down = True
    response = create_election(client, election_payload)
    assert response.status_code == 502
    with session_factory() as session:
        assert session.scalars(select(Election)).all() == []

    ballot.down = False  # El alta se puede reintentar.
    assert create_election(client, election_payload).status_code == 201


def test_close_and_status(client, ballot, election_payload):
    election_id = create_ok(client, election_payload)
    ballot.ballots[election_id] = 7

    status = client.get(f"/elections/{election_id}/status", headers=ADMIN).json()
    assert status == {
        "election_id": election_id,
        "identity_status": "open",
        "ballot_status": "open",
        "total_ballots": 7,
    }

    closed = client.post(f"/elections/{election_id}/close", headers=ADMIN).json()
    assert closed["status"] == "closed"
    assert election_id in ballot.closed
    # Repetir el cierre sigue siendo exitoso.
    assert client.post(f"/elections/{election_id}/close", headers=ADMIN).status_code == 200
    status = client.get(f"/elections/{election_id}/status", headers=ADMIN).json()
    assert status["identity_status"] == "closed" and status["ballot_status"] == "closed"


def test_unknown_or_malformed_election_ids_are_404(client, new_user):
    user = voter(new_user())
    for bad in ("999", "0", "-1", "abc", "1.5", "99999999999999999999"):
        assert client.post(f"/elections/{bad}/close", headers=ADMIN).status_code == 404, bad
        assert client.get(f"/elections/{bad}/parameters", headers=user).status_code == 404, bad


def test_status_and_close_require_admin(client, election_payload, new_user):
    election_id = create_ok(client, election_payload)
    user = voter(new_user())
    assert client.get(f"/elections/{election_id}/status", headers=user).status_code == 403
    assert client.post(f"/elections/{election_id}/close", headers=user).status_code == 403


# --- token anónimo ----------------------------------------------------------


def test_happy_path_blind_token_verifies_without_identity_seeing_it(
    client, election_payload, enroll, new_user, keys
):
    election_id = create_ok(client, election_payload)
    user_id = new_user()
    enroll(user_id, election_id)

    # Navegador: descarga parámetros, genera y ciega el token.
    params = client.get(f"/elections/{election_id}/parameters", headers=voter(user_id)).json()
    public_key = load_der_public_key(b64url_decode(params["token_key"]["public_key_der"]))
    nonce, prepared = rsabssa_client.new_prepared_token_message(election_id)
    blinded, inv = rsabssa_client.blind(public_key, prepared)

    response = request_token(client, election_id, voter(user_id), blinded)
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


def test_second_token_for_same_user_and_election_is_rejected(
    client, election_payload, enroll, new_user
):
    election_id = create_ok(client, election_payload)
    user_id = new_user()
    enroll(user_id, election_id)

    assert request_token(client, election_id, voter(user_id)).status_code == 200
    response = request_token(client, election_id, voter(user_id))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "token_already_issued"


def test_each_voter_gets_one_token(client, election_payload, enroll, new_user):
    election_id = create_ok(client, election_payload)
    first, second = new_user(), new_user()
    enroll(first, election_id)
    enroll(second, election_id)
    assert request_token(client, election_id, voter(first)).status_code == 200
    assert request_token(client, election_id, voter(second)).status_code == 200


def test_same_user_can_vote_in_two_elections(client, election_payload, enroll, new_user):
    first_election = create_ok(client, election_payload)
    second_election = create_ok(client, election_payload)
    user_id = new_user()
    enroll(user_id, first_election)
    enroll(user_id, second_election)
    assert request_token(client, first_election, voter(user_id)).status_code == 200
    assert request_token(client, second_election, voter(user_id)).status_code == 200


def test_user_outside_voter_roll_gets_no_token(client, election_payload, new_user, session_factory):
    election_id = create_ok(client, election_payload)
    response = request_token(client, election_id, voter(new_user()))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "not_in_voter_roll"
    with session_factory() as session:
        assert session.scalars(select(IssuedToken)).all() == []


def test_ineligible_voter_roll_entry_gets_no_token(client, election_payload, enroll, new_user):
    election_id = create_ok(client, election_payload)
    user_id = new_user()
    enroll(user_id, election_id, is_eligible=False)
    response = request_token(client, election_id, voter(user_id))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "not_in_voter_roll"


def test_requires_authentication(client, election_payload):
    election_id = create_ok(client, election_payload)
    response = client.post(
        "/tokens/blind",
        json={"election_id": election_id, "blinded_token": b64url_encode(b"\x01" * 256)},
    )
    assert response.status_code == 401


def test_unknown_election_is_404(client, new_user):
    assert request_token(client, "999", voter(new_user())).status_code == 404


def test_closed_election_issues_no_tokens(client, election_payload, enroll, new_user):
    election_id = create_ok(client, election_payload)
    user_id = new_user()
    enroll(user_id, election_id)
    client.post(f"/elections/{election_id}/close", headers=ADMIN)
    response = request_token(client, election_id, voter(user_id))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "election_not_open"


def test_election_not_yet_open_issues_no_tokens(client, election_payload, enroll, new_user):
    now = int(time.time())
    future = {**election_payload, "opens_at": now + 600, "closes_at": now + 1200}
    election_id = create_ok(client, future)
    user_id = new_user()
    enroll(user_id, election_id)
    assert request_token(client, election_id, voter(user_id)).status_code == 409


def test_invalid_blinded_message_does_not_consume_the_token(
    client, election_payload, enroll, new_user
):
    election_id = create_ok(client, election_payload)
    user_id = new_user()
    enroll(user_id, election_id)

    assert request_token(client, election_id, voter(user_id), b"\x01" * 10).status_code == 400
    assert request_token(client, election_id, voter(user_id), b"\xff" * 256).status_code == 400
    bad_encoding = client.post(
        "/tokens/blind",
        json={"election_id": election_id, "blinded_token": "***"},
        headers=voter(user_id),
    )
    assert bad_encoding.status_code == 400
    assert request_token(client, election_id, voter(user_id)).status_code == 200


def test_identity_stores_no_link_between_user_and_token(
    client, election_payload, enroll, new_user, session_factory
):
    election_id = create_ok(client, election_payload)
    user_id = new_user()
    enroll(user_id, election_id)
    blinded = b"\x07" * 256
    signature = b64url_decode(
        request_token(client, election_id, voter(user_id), blinded).json()["blind_signature"]
    )

    columns = {c["name"] for c in inspect(session_factory.kw["bind"]).get_columns("issued_tokens")}
    assert columns == {"id", "user_id", "election_id", "issued_at"}
    with session_factory() as session:
        row = session.scalars(select(IssuedToken)).one()
        stored = json.dumps([row.user_id, row.election_id]).encode()
        assert blinded not in stored and signature not in stored
        assert (row.user_id, row.election_id) == (user_id, int(election_id))


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


def test_root_keeps_the_original_service_message(client):
    assert client.get("/").json() == {"message": "Identity service running"}


def test_dev_auth_disabled_by_default(session_factory, ballot, keys):
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app

    app = create_app(
        Settings(dev_auth=False), session_factory=session_factory, ballot=ballot, keys=keys
    )
    with TestClient(app) as strict_client:
        assert strict_client.post("/elections", json={}, headers=ADMIN).status_code == 401


def test_dev_auth_rejects_non_numeric_user(client, election_payload):
    for bad in ("abc", "0", "-3", "1.5", ""):
        response = client.post(
            "/elections",
            json=election_payload,
            headers={"X-Dev-User": bad, "X-Dev-Roles": "admin"},
        )
        assert response.status_code == 401, bad
