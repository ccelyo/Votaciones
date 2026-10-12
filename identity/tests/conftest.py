import itertools
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.ballot_client import ElectionRegistration, TokenKey
from app.config import Settings
from app.errors import BallotUnavailable
from app.keys import load_keys
from app.main import create_app
from app.models import Base, Role, User, VoterRollEntry

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
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def client(session_factory, ballot, keys):
    app = create_app(
        Settings(dev_auth=True), session_factory=session_factory, ballot=ballot, keys=keys
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
                    user_id=user_id, election_id=int(election_id), is_eligible=is_eligible
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
