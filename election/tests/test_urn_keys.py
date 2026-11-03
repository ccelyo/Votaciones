"""Gestión de las llaves de la urna (FA-09)."""

import secrets
import struct

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select

from app.encoding import b64url_decode, b64url_encode
from app.keys import load_keys
from app.models import ElectionAudit, UrnKey
from tests.conftest import ADMIN, VOTER

OAEP = padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)


def encrypt_vote(public_key_der: bytes, option: str) -> bytes:
    """Lo que hace el cliente: formato compacto que descifra Tally."""
    public_key = serialization.load_der_public_key(public_key_der)
    content_key = AESGCM.generate_key(bit_length=256)
    nonce = secrets.token_bytes(12)
    wrapped = public_key.encrypt(content_key, OAEP)
    ciphertext = AESGCM(content_key).encrypt(nonce, option.encode(), None)
    return struct.pack(">H", len(wrapped)) + wrapped + nonce + ciphertext


def decrypt_vote(private_pem: str, envelope: bytes) -> str:
    """Lo que hace Tally con la llave entregada."""
    private_key = serialization.load_pem_private_key(private_pem.encode(), password=None)
    (key_len,) = struct.unpack(">H", envelope[:2])
    wrapped, rest = envelope[2 : 2 + key_len], envelope[2 + key_len :]
    content_key = private_key.decrypt(wrapped, OAEP)
    return AESGCM(content_key).decrypt(rest[:12], rest[12:], None).decode()


@pytest.fixture
def opened(client, create):
    election_id = create()["election_id"]
    client.post(f"/elections/{election_id}/open", headers=ADMIN)
    return election_id


def test_private_key_is_never_stored_in_clear(opened, session_factory):
    with session_factory() as session:
        stored = session.get(UrnKey, int(opened))
        assert b"PRIVATE KEY" not in stored.wrapped_private_key
        assert len(stored.wrap_nonce) == 12
        assert stored.release_count == 0


def test_private_key_only_after_close(client, opened):
    response = client.post(f"/elections/{opened}/urn-key/private", headers=ADMIN)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "invalid_state"


def test_private_key_requires_admin(client, opened):
    client.post(f"/elections/{opened}/close", headers=ADMIN)
    assert client.post(f"/elections/{opened}/urn-key/private", headers=VOTER).status_code == 403
    assert client.post(f"/elections/{opened}/urn-key/private").status_code == 401


def test_vote_encrypted_with_public_key_opens_with_released_key(client, opened, session_factory):
    params = client.get(f"/elections/{opened}/parameters", headers=VOTER).json()
    ballot = encrypt_vote(b64url_decode(params["encryption"]["public_key"]), "Candidato B")

    client.post(f"/elections/{opened}/close", headers=ADMIN)
    response = client.post(f"/elections/{opened}/urn-key/private", headers=ADMIN)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["algorithm"] == "RSA-OAEP-256+A256GCM"
    assert body["release_count"] == 1
    assert decrypt_vote(body["private_key"], ballot) == "Candidato B"

    again = client.post(f"/elections/{opened}/urn-key/private", headers=ADMIN).json()
    assert again["release_count"] == 2
    with session_factory() as session:
        actions = session.scalars(
            select(ElectionAudit.action).where(ElectionAudit.election_id == int(opened))
        ).all()
    assert actions.count("urn_key_released") == 2


def test_each_election_has_its_own_urn_key(client, create):
    first, second = create()["election_id"], create(name="Otra")["election_id"]
    for election_id in (first, second):
        client.post(f"/elections/{election_id}/open", headers=ADMIN)
    key_a = client.get(f"/elections/{first}/parameters", headers=ADMIN).json()["encryption"]
    key_b = client.get(f"/elections/{second}/parameters", headers=ADMIN).json()["encryption"]
    assert key_a["public_key"] != key_b["public_key"]


def test_wrapped_key_is_bound_to_its_election(client, create, session_factory, keys):
    first, second = create()["election_id"], create(name="Otra")["election_id"]
    for election_id in (first, second):
        client.post(f"/elections/{election_id}/open", headers=ADMIN)
        client.post(f"/elections/{election_id}/close", headers=ADMIN)
    # Copiar el blob cifrado de una urna a otra no permite descifrarlo.
    with session_factory() as session:
        source, target = session.get(UrnKey, int(first)), session.get(UrnKey, int(second))
        target.wrapped_private_key, target.wrap_nonce = source.wrapped_private_key, source.wrap_nonce
        session.commit()
    response = client.post(f"/elections/{second}/urn-key/private", headers=ADMIN)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "urn_key_unavailable"


def test_wrong_master_key_cannot_unwrap(keys, tmp_path):
    generated = keys.generate_urn_key("1")
    other = load_keys(tmp_path, urn_key_bits=2048)
    with pytest.raises(ValueError):
        other.unwrap_urn_key("1", generated.wrapped_private_key, generated.wrap_nonce, generated.kek_id)


def test_master_key_from_environment(tmp_path):
    kek = b64url_encode(secrets.token_bytes(32))
    first = load_keys(tmp_path / "a", urn_kek=kek, urn_key_bits=2048)
    second = load_keys(tmp_path / "b", urn_kek=kek, urn_key_bits=2048)
    assert first.kek_id == second.kek_id
    generated = first.generate_urn_key("9")
    second.unwrap_urn_key("9", generated.wrapped_private_key, generated.wrap_nonce, generated.kek_id)
    with pytest.raises(ValueError):
        load_keys(tmp_path / "c", urn_kek=b64url_encode(b"short"))


def test_keys_persist_across_restarts(tmp_path):
    first = load_keys(tmp_path, urn_key_bits=2048)
    second = load_keys(tmp_path, urn_key_bits=2048)
    assert first.parameter_key_id == second.parameter_key_id
    assert first.kek_id == second.kek_id
    assert oct((tmp_path / "urn_kek.bin").stat().st_mode)[-3:] == "600"
