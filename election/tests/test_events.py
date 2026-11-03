"""Productor de election.events: outbox, orden, reintentos y contrato (FA-06)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from app import service
from app.events import OutboxRelay, publish_pending
from app.models import OutboxEvent
from tests.conftest import ADMIN, iso_in


def _open(client, create, **overrides) -> str:
    election_id = create(**overrides)["election_id"]
    assert client.post(f"/elections/{election_id}/open", headers=ADMIN).status_code == 200
    return election_id


def test_drafts_do_not_emit_events(client, create, session_factory, publisher):
    election_id = create()["election_id"]
    client.patch(f"/elections/{election_id}", json={"name": "Otro"}, headers=ADMIN)
    client.delete(f"/elections/{election_id}", headers=ADMIN)
    assert publish_pending(session_factory, publisher) == 0


def test_lifecycle_events_in_order_with_common_envelope(client, create, session_factory, publisher):
    election_id = _open(client, create)
    client.post(f"/elections/{election_id}/close", headers=ADMIN)
    client.post(f"/elections/{election_id}/close", headers=ADMIN)  # idempotente: sin evento

    assert publish_pending(session_factory, publisher) == 3
    assert publisher.types == ["election.created", "election.opened", "election.closed"]
    for routing_key, envelope in publisher.messages:
        assert envelope["event_type"] == routing_key
        assert envelope["producer"] == "election"
        assert envelope["schema_version"] == 1
        assert envelope["occurred_at"].endswith("Z")
        assert envelope["data"]["election_id"] == election_id
    assert len({envelope["event_id"] for _, envelope in publisher.messages}) == 3


def test_created_event_matches_analytics_contract(client, create, session_factory, publisher):
    election_id = _open(client, create)
    publish_pending(session_factory, publisher)
    data = publisher.messages[0][1]["data"]

    # Campos obligatorios de analytics/CONTRACTS.md §3.1.
    assert data["options"] == ["Candidata A", "Candidato B", "Voto en blanco"]
    assert data["blank_option"] in data["options"]
    opens = datetime.fromisoformat(data["opens_at"])
    closes = datetime.fromisoformat(data["closes_at"])
    assert closes > opens
    # Lo que necesita Ballot (AN-10) para aceptar papeletas.
    params = client.get(f"/elections/{election_id}/parameters", headers=ADMIN).json()
    assert data["encryption"] == params["encryption"]
    assert data["signed_parameters"] == params["signed_parameters"]
    assert data["signature"] == params["signature"]


def test_closed_event_contract(client, create, session_factory, publisher):
    election_id = _open(client, create)
    closed = client.post(f"/elections/{election_id}/close", headers=ADMIN).json()
    publish_pending(session_factory, publisher)
    data = publisher.messages[-1][1]["data"]
    assert data == {"election_id": election_id, "closed_at": closed["closed_at"], "reason": "manual"}


def test_broker_down_keeps_events_and_retries_with_same_event_id(
    client, create, session_factory, publisher
):
    _open(client, create)
    publisher.down = True
    assert publish_pending(session_factory, publisher) == 0
    with session_factory() as session:
        first = session.scalars(select(OutboxEvent).order_by(OutboxEvent.id)).first()
        assert first.attempts == 1
        assert "broker unavailable" in first.last_error
        stored_id = str(first.event_id)

    publisher.down = False
    assert publish_pending(session_factory, publisher) == 2
    assert publisher.messages[0][1]["event_id"] == stored_id
    assert publish_pending(session_factory, publisher) == 0


def test_failed_transaction_does_not_leave_events(client, create, session_factory):
    election_id = create()["election_id"]
    client.post(f"/elections/{election_id}/open", headers=ADMIN)
    client.post(f"/elections/{election_id}/open", headers=ADMIN)  # 409: no agrega eventos
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(OutboxEvent)) == 2


def test_auto_close_expired_elections(client, create, session_factory, publisher):
    election_id = _open(client, create, closes_at=iso_in(minutes=10))
    later = datetime.now(UTC) + timedelta(minutes=11)
    with session_factory() as session:
        assert service.close_expired_elections(session, now=later) == [election_id]
        assert service.close_expired_elections(session, now=later) == []

    body = client.get(f"/elections/{election_id}", headers=ADMIN).json()
    assert body["status"] == "closed"
    assert body["closed_at"] == body["closes_at"]
    publish_pending(session_factory, publisher)
    assert publisher.messages[-1][1]["data"]["reason"] == "schedule"


def test_relay_runs_periodic_task_and_publishes(client, create, session_factory, publisher):
    _open(client, create)
    calls = []
    relay = OutboxRelay(
        session_factory, publisher, interval_seconds=60, batch_size=1, periodic=lambda: calls.append(1)
    )
    relay.run_once()
    assert calls == [1]
    assert publisher.types == ["election.created", "election.opened"]
