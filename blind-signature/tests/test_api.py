import base64

import pytest

from cryptography.hazmat.primitives import serialization

from app import blind_rsa
from app.main import create_app
from app.config import Settings
from fastapi.testclient import TestClient
from tests import rsabssa_client
from tests.conftest import TOKEN


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def public_key(client, election_id="7"):
    body = client.get(f"/v1/keys/{election_id}").json()
    return body, serialization.load_der_public_key(unb64(body["public_key_der"]))


def test_key_is_created_once_per_election_and_is_stable(client):
    first, _ = public_key(client, "1")
    again, _ = public_key(client, "1")
    other, _ = public_key(client, "2")
    assert first == again
    assert first["kid"] != other["kid"]
    assert first["variant"] == blind_rsa.VARIANT


def test_full_blind_signature_flow_verifies_with_public_key(client):
    body, key = public_key(client)
    _, prepared = rsabssa_client.new_prepared_token_message("7")
    blinded, inv = rsabssa_client.blind(key, prepared)

    response = client.post("/v1/sign", json={"election_id": "7", "blinded_message": b64(blinded)})

    assert response.status_code == 200
    assert response.json()["kid"] == body["kid"]
    signature = rsabssa_client.finalize(key, prepared, unb64(response.json()["blind_signature"]), inv)
    rsabssa_client.verify(key, prepared, signature)


def test_signature_for_one_election_does_not_verify_for_another(client):
    _, key_other = public_key(client, "8")
    _, key = public_key(client, "7")
    _, prepared = rsabssa_client.new_prepared_token_message("7")
    blinded, inv = rsabssa_client.blind(key, prepared)
    sig = client.post("/v1/sign", json={"election_id": "7", "blinded_message": b64(blinded)}).json()
    signature = rsabssa_client.finalize(key, prepared, unb64(sig["blind_signature"]), inv)
    try:
        rsabssa_client.verify(key_other, prepared, signature)
    except Exception:
        return
    raise AssertionError("signature verified under another election's key")


def test_rejects_malformed_blinded_message(client):
    public_key(client)
    short = client.post("/v1/sign", json={"election_id": "7", "blinded_message": b64(b"\x01" * 10)})
    assert short.status_code == 400
    bad = client.post("/v1/sign", json={"election_id": "7", "blinded_message": "***"})
    assert bad.status_code == 400


def test_service_does_not_accept_voter_identity(client):
    """El contrato no admite campos de identidad: se rechazan por esquema estricto."""
    response = client.post(
        "/v1/sign",
        json={"election_id": "7", "blinded_message": "AA", "user_id": 5},
    )
    assert response.status_code == 422


def test_election_id_cannot_escape_keys_dir(client):
    assert client.get("/v1/keys/..%2Fsecret").status_code in (400, 404)
    assert client.post(
        "/v1/sign", json={"election_id": "../x", "blinded_message": "AA"}
    ).status_code == 400


def test_service_refuses_to_start_without_the_secret(tmp_path):
    for value in ("", "   "):
        with pytest.raises(RuntimeError, match="BLINDSIG_API_KEY is required"):
            create_app(Settings(keys_dir=tmp_path / "k", api_key=value))


def test_missing_env_var_also_fails_at_startup(tmp_path, monkeypatch):
    monkeypatch.delenv("BLINDSIG_API_KEY", raising=False)
    monkeypatch.setenv("BLINDSIG_KEYS_DIR", str(tmp_path / "k"))
    with pytest.raises(RuntimeError, match="BLINDSIG_API_KEY is required"):
        create_app(Settings(_env_file=None))


def test_request_without_token_gets_401_on_every_protected_operation(anonymous_client):
    assert anonymous_client.get("/v1/keys/1").status_code == 401
    sign = anonymous_client.post("/v1/sign", json={"election_id": "1", "blinded_message": "AA"})
    assert sign.status_code == 401


def test_request_with_wrong_token_gets_401_and_never_echoes_secrets(anonymous_client):
    wrong = {"X-Internal-Token": "otro-secreto"}
    for response in (
        anonymous_client.get("/v1/keys/1", headers=wrong),
        anonymous_client.post(
            "/v1/sign", headers=wrong, json={"election_id": "1", "blinded_message": "AA"}
        ),
    ):
        assert response.status_code == 401
        assert TOKEN not in response.text and "otro-secreto" not in response.text


def test_request_with_correct_token_works(anonymous_client):
    ok = anonymous_client.get("/v1/keys/1", headers={"X-Internal-Token": TOKEN})
    assert ok.status_code == 200


def test_health_needs_no_token(anonymous_client):
    response = anonymous_client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
