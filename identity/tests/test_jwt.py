import hashlib
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select

from app import jwt_tokens
from app.config import Settings
from app.encoding import b64url_encode
from app.errors import Unauthenticated
from app.models import Role, User, UserSession
from app.security import hash_password

ISSUER = Settings().jwt_issuer
AUDIENCE = Settings().jwt_audience


def create_user(session_factory, username="ana", role="admin", password="prueba123") -> int:
    with session_factory() as session:
        role_row = session.scalar(select(Role).where(Role.name == role))
        if role_row is None:
            role_row = Role(name=role)
            session.add(role_row)
            session.flush()
        user = User(username=username, password_hash=hash_password(password), role_id=role_row.id)
        session.add(user)
        session.commit()
        return user.id


def log_in(client, username="ana", password="prueba123") -> dict:
    challenge = client.post("/login", json={"username": username, "password": password})
    assert challenge.status_code == 200, challenge.text
    mfa = client.post(
        "/login/mfa",
        json={"challenge_id": challenge.json()["challenge_id"], "code": "123456"},
    )
    assert mfa.status_code == 200, mfa.text
    return mfa.json()


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def claims_for(user_id: int, **overrides) -> dict:
    now = int(time.time())
    return {
        "iss": ISSUER, "aud": AUDIENCE, "sub": str(user_id), "role": "admin",
        "iat": now, "nbf": now, "exp": now + 60, "jti": "x",
    } | overrides


def gateway_decode(client, token: str) -> dict:
    """Lo que hace el Gateway: validar solo con el JWKS público."""
    jwks = client.get("/.well-known/jwks.json").json()
    kid = jwt.get_unverified_header(token)["kid"]
    jwk = next(key for key in jwks["keys"] if key["kid"] == kid)
    return jwt.decode(
        token, jwt.PyJWK(jwk).key, algorithms=["RS256"], issuer=ISSUER, audience=AUDIENCE
    )


def test_mfa_returns_rs256_jwt_the_gateway_can_verify_with_jwks(client, session_factory):
    user_id = create_user(session_factory)
    body = log_in(client)

    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 3600
    header = jwt.get_unverified_header(body["access_token"])
    assert header["alg"] == "RS256" and header["typ"] == "JWT"

    claims = gateway_decode(client, body["access_token"])
    assert claims["sub"] == str(user_id)
    assert claims["username"] == "ana"
    assert claims["role"] == "admin"
    assert claims["iss"] == ISSUER and claims["aud"] == AUDIENCE
    assert claims["exp"] - claims["iat"] == 3600
    assert claims["nbf"] == claims["iat"]
    assert claims["jti"]


def test_jwt_authorizes_admin_endpoints(client, session_factory):
    create_user(session_factory)
    token = log_in(client)["access_token"]
    assert client.get("/elections", headers=bearer(token)).status_code == 200
    assert client.get("/auth/me", headers=bearer(token)).json()["role"] == "admin"


def test_only_the_jti_hash_is_stored(client, session_factory):
    create_user(session_factory)
    token = log_in(client)["access_token"]
    jti = jwt.decode(token, options={"verify_signature": False})["jti"]
    with session_factory() as session:
        stored = session.scalars(select(UserSession.token_hash)).all()
    assert stored == [hashlib.sha256(jti.encode()).hexdigest()]


def test_jwt_key_is_not_the_blind_signing_key(client, keys):
    jwks = client.get("/.well-known/jwks.json").json()
    assert [key["kid"] for key in jwks["keys"]] == [keys.jwt_kid]
    assert keys.jwt_kid != keys.token_kid
    assert (
        keys.jwt_private.public_key().public_numbers().n
        != keys.token_private.public_key().public_numbers().n
    )
    assert set(jwks["keys"][0]) == {"kty", "use", "alg", "kid", "n", "e"}


def test_tampered_token_is_rejected(client, session_factory):
    create_user(session_factory, username="vot", role="voter")
    token = log_in(client, "vot")["access_token"]
    header, _, signature = token.split(".")
    claims = jwt.decode(token, options={"verify_signature": False}) | {"role": "admin"}
    payload = b64url_encode(json.dumps(claims, separators=(",", ":")).encode())
    forged = f"{header}.{payload}.{signature}"
    assert client.get("/auth/me", headers=bearer(forged)).status_code == 401


def test_token_signed_with_another_key_is_rejected(client, session_factory, keys):
    user_id = create_user(session_factory)
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = jwt.encode(
        claims_for(user_id), other, algorithm="RS256", headers={"kid": keys.jwt_kid}
    )
    assert client.get("/auth/me", headers=bearer(forged)).status_code == 401


def test_alg_none_is_rejected(client, session_factory, keys):
    user_id = create_user(session_factory)
    unsigned = jwt.encode(
        claims_for(user_id), None, algorithm="none", headers={"kid": keys.jwt_kid}
    )
    assert client.get("/auth/me", headers=bearer(unsigned)).status_code == 401


@pytest.mark.parametrize(
    ("age", "issuer", "audience"),
    [
        (7200, ISSUER, AUDIENCE),  # expirado
        (0, "otro-emisor", AUDIENCE),
        (0, ISSUER, "otra-audiencia"),
    ],
)
def test_expired_or_foreign_tokens_are_rejected(keys, age, issuer, audience):
    token = jwt_tokens.issue_access_token(
        keys, user_id=1, username="ana", role="admin", jti="j",
        issued_at=int(time.time()) - age, ttl_seconds=3600, issuer=issuer, audience=audience,
    )
    with pytest.raises(Unauthenticated):
        jwt_tokens.decode_access_token(keys, token, issuer=ISSUER, audience=AUDIENCE)


def test_logout_revokes_the_jwt_inside_identity(client, session_factory):
    create_user(session_factory)
    token = log_in(client)["access_token"]
    assert client.post("/logout", headers=bearer(token)).status_code == 204
    assert client.get("/auth/me", headers=bearer(token)).status_code == 401


def test_deactivated_user_loses_access_immediately(client, session_factory):
    create_user(session_factory)
    voter_id = create_user(session_factory, username="vot", role="voter")
    admin_token = log_in(client)["access_token"]
    voter_token = log_in(client, "vot")["access_token"]

    response = client.patch(
        f"/users/{voter_id}", json={"is_active": False}, headers=bearer(admin_token)
    )
    assert response.status_code == 200
    assert client.get("/auth/me", headers=bearer(voter_token)).status_code == 401
