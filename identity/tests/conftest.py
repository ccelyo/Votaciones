import hashlib
import itertools
import time

import pytest
from fastapi.testclient import TestClient
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.clients.ballot_client import ElectionRegistration, TokenKey
from app.core.config import Settings
from app.clients.blind_signature import BlindSignature
from app.core.errors import BallotUnavailable, BlindSignatureUnavailable, InvalidRequest
from app.core.keys import load_keys
from app.main import create_app
from app.db.census import CensusBase, VoterRollEntry
from app.db.models import Base, Role, User

ADMIN = {"X-Dev-User": "1", "X-Dev-Roles": "admin"}


def voter(user_id: int) -> dict:
    return {"X-Dev-User": str(user_id), "X-Dev-Roles": "voter"}


class FakeBallot:
    """Doble en memoria de `BallotGateway`."""

    def __init__(self):
        self.registrations: dict[str, ElectionRegistration] = {}
        self.closed: set[str] = set()
        self.ballots: dict[str, int] = {}
        self.down = False

    def _check(self):
        if self.down:
            raise BallotUnavailable("ballot service error (UNAVAILABLE)")

    def register_election(self, registration: ElectionRegistration) -> bool:
        self._check()
        created = registration.election_id not in self.registrations
        self.registrations[registration.election_id] = registration
        return created

    def add_token_verification_key(self, election_id: str, key: TokenKey) -> bool:
        self._check()
        return True

    def close_election(self, election_id: str) -> str:
        self._check()
        self.closed.add(election_id)
        return "closed"

    def get_election_status(self, election_id: str) -> str:
        self._check()
        if election_id not in self.registrations:
            return "not_found"
        return "closed" if election_id in self.closed else "open"

    def count_ballots(self, election_id: str) -> int:
        self._check()
        return self.ballots.get(election_id, 0)


class FakeBlindSigner:
    """Doble de Blind Signature: misma matemática RSA, sin red.

    Registra lo que RECIBE para poder comprobar que Identity nunca le envía datos
    del votante: solo ``election_id`` y el mensaje cegado.
    """

    VARIANT = "RSABSSA-SHA384-PSS-Randomized"

    def __init__(self, private: rsa.RSAPrivateKey):
        self.private = private
        self.calls: list[tuple] = []
        self.down = False

    @property
    def public_der(self) -> bytes:
        return self.private.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    @property
    def kid(self) -> str:
        return hashlib.sha256(self.public_der).hexdigest()[:16]

    def token_key(self, election_id: str) -> TokenKey:
        if self.down:
            raise BlindSignatureUnavailable("blind signature service unreachable")
        return TokenKey(self.kid, self.public_der, self.VARIANT)

    def sign(self, election_id: str, blinded_message: bytes) -> BlindSignature:
        if self.down:
            raise BlindSignatureUnavailable("blind signature service unreachable")
        self.calls.append((election_id, blinded_message))
        numbers = self.private.private_numbers()
        n = numbers.public_numbers.n
        if len(blinded_message) != 256 or int.from_bytes(blinded_message, "big") >= n:
            raise InvalidRequest("blinded message is not valid for this key")
        s = pow(int.from_bytes(blinded_message, "big"), numbers.d, n)
        return BlindSignature(self.kid, self.VARIANT, s.to_bytes(256, "big"))


@pytest.fixture(scope="session")
def signer_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def signer(signer_key):
    return FakeBlindSigner(signer_key)


@pytest.fixture(scope="session")
def keys(tmp_path_factory):
    return load_keys(tmp_path_factory.mktemp("keys"))


@pytest.fixture
def ballot():
    return FakeBallot()


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def _enforce_foreign_keys(connection, _):  # PostgreSQL siempre las aplica.
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    CensusBase.metadata.create_all(engine)  # en pruebas Census comparte el SQLite
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def client(session_factory, ballot, keys, signer):
    app = create_app(
        Settings(dev_auth=True),
        session_factory=session_factory,
        census_session_factory=session_factory,
        ballot=ballot,
        blind_signer=signer,
        keys=keys,
    )
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def new_user(session_factory):
    """Crea un usuario real en `users` (con su rol) y devuelve su id."""
    counter = itertools.count(100)

    def _new_user() -> int:
        with session_factory() as session:
            role = session.scalar(select(Role).where(Role.name == "voter"))
            if role is None:
                role = Role(name="voter")
                session.add(role)
                session.flush()
            user = User(username=f"user{next(counter)}", password_hash="x", role_id=role.id)
            session.add(user)
            session.commit()
            return user.id

    return _new_user


@pytest.fixture
def enroll(session_factory):
    def _enroll(user_id: int, election_id: str, *, is_eligible: bool = True) -> None:
        with session_factory() as session:
            session.add(
                VoterRollEntry(
                    voter_id=str(user_id), election_id=election_id, is_eligible=is_eligible
                )
            )
            session.commit()

    return _enroll


@pytest.fixture
def election_payload():
    now = int(time.time())
    return {
        "name": "Elección de representantes 2026",
        "options": ["Alpha", "Beta", "Blanco"],
        "encryption_public_key": "cHVibGljLWVsZWN0aW9uLWtleQ",  # "public-election-key"
        "opens_at": now - 60,
        "closes_at": now + 3600,
    }
