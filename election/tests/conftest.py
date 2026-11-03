import json
import time
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import Settings
from app.keys import load_keys
from app.main import create_app
from app.models import Base

JWT_SECRET = "test-secret-with-at-least-32-bytes!!"
ADMIN = {"X-Dev-User": "admin-1", "X-Dev-Roles": "admin"}
VOTER = {"X-Dev-User": "voter-1", "X-Dev-Roles": "voter"}


def bearer(sub: str = "admin-1", roles: list[str] | None = None, **claims) -> dict:
    payload = {"sub": sub, "roles": roles or ["admin"], "exp": int(time.time()) + 300, **claims}
    return {"Authorization": f"Bearer {jwt.encode(payload, JWT_SECRET, algorithm='HS256')}"}


def iso_in(**delta) -> str:
    return (datetime.now(UTC) + timedelta(**delta)).replace(microsecond=0).isoformat()


def election_body(**overrides) -> dict:
    body = {
        "name": "Consejo Superior 2026",
        "description": "Representante estudiantil",
        "options": ["Candidata A", "Candidato B", "Voto en blanco"],
        "blank_option": "Voto en blanco",
        "opens_at": iso_in(minutes=-1),
        "closes_at": iso_in(hours=8),
    }
    body.update(overrides)
    return body


class FakePublisher:
    """Doble de RabbitPublisher que guarda lo publicado."""

    def __init__(self):
        self.messages: list[tuple[str, dict]] = []
        self.down = False

    def publish(self, routing_key: str, event_id: str, body: bytes) -> None:
        if self.down:
            raise ConnectionError("broker unavailable")
        self.messages.append((routing_key, json.loads(body)))

    def close(self) -> None:
        pass

    @property
    def types(self) -> list[str]:
        return [routing_key for routing_key, _ in self.messages]


@pytest.fixture(scope="session")
def keys(tmp_path_factory):
    return load_keys(tmp_path_factory.mktemp("keys"), urn_key_bits=2048)


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )

    @event.listens_for(engine, "connect")
    def _foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    yield sessionmaker(engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def settings():
    return Settings(dev_auth=True, jwt_secret=JWT_SECRET, rabbitmq_uri="", urn_key_bits=2048)


@pytest.fixture
def publisher():
    return FakePublisher()


@pytest.fixture
def client(settings, session_factory, keys):
    app = create_app(settings, session_factory=session_factory, keys=keys, start_relay=False)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def create(client):
    def _create(**overrides) -> dict:
        response = client.post("/elections", json=election_body(**overrides), headers=ADMIN)
        assert response.status_code == 201, response.text
        return response.json()

    return _create
