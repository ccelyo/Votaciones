import gzip
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app import blind_rsa
from tests import rsabssa_client

# Vectores RFC 9474 que ya usa `ballot` en sus pruebas de Go.
VECTORS = Path(__file__).parents[2] / "ballot/internal/token/testdata/rfc9474.json.gz"


def _load_vectors() -> list[dict]:
    if not VECTORS.exists():
        pytest.skip("RFC 9474 vectors not available outside the monorepo")
    with gzip.open(VECTORS) as handle:
        return json.load(handle)


def _hex(value: str) -> int:
    return int(value, 16)


def _private_key(vector: dict) -> rsa.RSAPrivateKey:
    p, q, d, e = (_hex(vector[name]) for name in ("p", "q", "d", "e"))
    return rsa.RSAPrivateNumbers(
        p=p,
        q=q,
        d=d,
        dmp1=rsa.rsa_crt_dmp1(d, p),
        dmq1=rsa.rsa_crt_dmq1(d, q),
        iqmp=rsa.rsa_crt_iqmp(p, q),
        public_numbers=rsa.RSAPublicNumbers(e, p * q),
    ).private_key()


def test_blind_sign_matches_rfc9474_vectors():
    for vector in _load_vectors():
        private_key = _private_key(vector)
        blind_sig = blind_rsa.blind_sign(private_key, bytes.fromhex(vector["blinded_msg"]))
        assert blind_sig == bytes.fromhex(vector["blind_sig"]), vector["name"]


def test_test_client_reproduces_rfc9474_blinding_and_finalize():
    """Valida el cliente de pruebas contra el estándar antes de usarlo como oráculo."""
    for vector in _load_vectors():
        private_key = _private_key(vector)
        public_key = private_key.public_key()
        n = public_key.public_numbers().n
        inv = _hex(vector["inv"])
        prepared = bytes.fromhex(vector["input_msg"])

        salt = bytes.fromhex(vector["salt"])
        blinded, _ = rsabssa_client.blind(public_key, prepared, salt=salt, r=pow(inv, -1, n))
        assert blinded == bytes.fromhex(vector["blinded_msg"]), vector["name"]
        signature = rsabssa_client.finalize(
            public_key, prepared, bytes.fromhex(vector["blind_sig"]), inv, salt_len=len(salt)
        )
        assert signature == bytes.fromhex(vector["sig"]), vector["name"]


def test_blind_sign_rejects_wrong_length(keys):
    with pytest.raises(blind_rsa.BlindSignError):
        blind_rsa.blind_sign(keys.token_private, b"\x01" * 10)


def test_blind_sign_rejects_representative_out_of_range(keys):
    n = keys.token_private.public_key().public_numbers().n
    k = blind_rsa.modulus_size(keys.token_private.public_key())
    with pytest.raises(blind_rsa.BlindSignError):
        blind_rsa.blind_sign(keys.token_private, n.to_bytes(k, "big"))
    with pytest.raises(blind_rsa.BlindSignError):
        blind_rsa.blind_sign(keys.token_private, b"\xff" * k)


def test_blind_sign_round_trip_with_generated_key(keys):
    public_key = keys.token_private.public_key()
    _, prepared = rsabssa_client.new_prepared_token_message("any-election")
    blinded, inv = rsabssa_client.blind(public_key, prepared)
    signature = rsabssa_client.finalize(
        public_key, prepared, blind_rsa.blind_sign(keys.token_private, blinded), inv
    )
    rsabssa_client.verify(public_key, prepared, signature)
