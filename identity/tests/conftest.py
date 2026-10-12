import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.ballot_client import ElectionRegistration, TokenKey
from app.config import Settings
from app.errors import BallotUnavailable
from app.keys import load_keys
from app.main import create_app
from app.models import Base, VoterRollEntry

ADMIN = {"X-Dev-User": "admin-1", "X-Dev-Roles": "admin"}


def voter(user_id: str) -> dict:
    return {"X-Dev-User": user_id, "X-Dev-Roles": "voter"}


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
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def client(session_factory, ballot, keys):
    app = create_app(
        Settings(dev_auth=True), session_factory=session_factory, ballot=ballot, keys=keys
    )
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def enroll(session_factory):
    def _enroll(user_id: str, election_id: str) -> None:
        with session_factory() as session:
            session.add(VoterRollEntry(user_id=user_id, election_id=election_id))
            session.commit()

    return _enroll


@pytest.fixture
def election_payload():
    now = int(time.time())
    return {
        "election_id": "elec-2026",
        "options": ["Alpha", "Beta", "Blanco"],
        "encryption_public_key": "cHVibGljLWVsZWN0aW9uLWtleQ",  # "public-election-key"
        "opens_at": now - 60,
        "closes_at": now + 3600,
    }
