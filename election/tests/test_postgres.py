"""Persistencia sobre PostgreSQL real con ``schema.sql`` (FA-02, FA-07).

Se ejecuta solo si ``ELECTION_TEST_DATABASE_URL`` apunta a una base vacía y
desechable: la prueba borra y recrea sus tablas.

    ELECTION_TEST_DATABASE_URL=postgresql://localhost:5433/elections_test uv run pytest
"""

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.config import normalize_database_url
from app.events import publish_pending
from app.main import create_app
from app.models import Base, Election, OutboxEvent
from tests.conftest import ADMIN, FakePublisher, election_body

URL = os.environ.get("ELECTION_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="ELECTION_TEST_DATABASE_URL not set")
SCHEMA = Path(__file__).parents[1] / "schema.sql"


@pytest.fixture
def pg_factory():
    engine = create_engine(normalize_database_url(URL))
    with engine.begin() as connection:
        for table in reversed(Base.metadata.sorted_tables):
            connection.execute(text(f"DROP TABLE IF EXISTS {table.name} CASCADE"))
        connection.exec_driver_sql(SCHEMA.read_text())
    yield sessionmaker(engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def pg_client(settings, pg_factory, keys):
    app = create_app(settings, session_factory=pg_factory, keys=keys, start_relay=False)
    with TestClient(app) as client:
        yield client


def test_full_lifecycle_on_postgres(pg_client, pg_factory):
    created = pg_client.post("/elections", json=election_body(), headers=ADMIN)
    assert created.status_code == 201, created.text
    election_id = created.json()["election_id"]

    updated = pg_client.patch(
        f"/elections/{election_id}",
        json={"options": ["A", "B", "Blanco"], "blank_option": "Blanco"},
        headers=ADMIN,
    )
    assert updated.status_code == 200, updated.text
    assert pg_client.post(f"/elections/{election_id}/open", headers=ADMIN).status_code == 200
    assert pg_client.get(f"/elections/{election_id}/parameters", headers=ADMIN).status_code == 200
    assert pg_client.post(f"/elections/{election_id}/close", headers=ADMIN).status_code == 200
    released = pg_client.post(f"/elections/{election_id}/urn-key/private", headers=ADMIN)
    assert released.status_code == 200

    publisher = FakePublisher()
    assert publish_pending(pg_factory, publisher) == 3
    assert publisher.types == ["election.created", "election.opened", "election.closed"]
    with pg_factory() as session:
        pending = session.scalar(
            select(func.count()).select_from(OutboxEvent).where(OutboxEvent.published_at.is_(None))
        )
        assert pending == 0


def test_delete_draft_cascades_on_postgres(pg_client, pg_factory):
    election_id = pg_client.post("/elections", json=election_body(), headers=ADMIN).json()["election_id"]
    assert pg_client.delete(f"/elections/{election_id}", headers=ADMIN).status_code == 204
    with pg_factory() as session:
        for table in ("election_options", "election_audit"):
            count = session.scalar(text(f"SELECT count(*) FROM {table} WHERE election_id = :id"), {"id": int(election_id)})
            assert count == 0


def test_database_enforces_lifecycle_and_blank_constraints(pg_client, pg_factory):
    election_id = int(pg_client.post("/elections", json=election_body(), headers=ADMIN).json()["election_id"])
    with pg_factory() as session:
        with pytest.raises(IntegrityError):
            # Una urna abierta sin opened_at viola ck_elections_lifecycle.
            session.execute(text("UPDATE elections SET status = 'open' WHERE id = :id"), {"id": election_id})
        session.rollback()
        with pytest.raises(IntegrityError):
            session.execute(
                text("UPDATE election_options SET is_blank = TRUE WHERE election_id = :id"),
                {"id": election_id},
            )
        session.rollback()
        assert session.get(Election, election_id).status == "draft"
