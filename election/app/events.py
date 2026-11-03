"""Productor de ``election.events`` (FA-06). Contrato en docs/eventos.md.

Patrón *outbox transaccional*: los casos de uso solo llaman a ``enqueue``, que
inserta el evento en ``outbox_events`` dentro de la misma transacción que el
cambio de estado. ``OutboxRelay`` los publica después en RabbitMQ con publisher
confirms, en orden, y los marca como publicados. Así nunca se publica un evento
de una transacción revertida ni se pierde uno si RabbitMQ está caído: el
``event_id`` se conserva entre reintentos y los consumidores descartan duplicados.
"""

import json
import logging
import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.encoding import iso
from app.models import Election, OutboxEvent

log = logging.getLogger(__name__)

PRODUCER = "election"
SCHEMA_VERSION = 1

ELECTION_CREATED = "election.created"
ELECTION_OPENED = "election.opened"
ELECTION_CLOSED = "election.closed"


# --- construcción ------------------------------------------------------------


def enqueue(session: Session, event_type: str, data: dict, *, occurred_at: datetime) -> OutboxEvent:
    event_id = uuid.uuid4()
    envelope = {
        "event_id": str(event_id),
        "event_type": event_type,
        "occurred_at": iso(occurred_at),
        "producer": PRODUCER,
        "schema_version": SCHEMA_VERSION,
        "data": data,
    }
    event = OutboxEvent(event_id=event_id, event_type=event_type, payload=envelope)
    session.add(event)
    return event


def created_data(election: Election, *, encryption: dict, signed_parameters: str, signature: dict) -> dict:
    return {
        "election_id": election.ref,
        "name": election.name,
        "description": election.description,
        "options": election.option_labels,
        "blank_option": election.blank_option,
        "opens_at": iso(election.opens_at),
        "closes_at": iso(election.closes_at),
        "encryption": encryption,
        "signed_parameters": signed_parameters,
        "signature": signature,
    }


def opened_data(election: Election) -> dict:
    return {
        "election_id": election.ref,
        "opened_at": iso(election.opened_at),
        "opens_at": iso(election.opens_at),
        "closes_at": iso(election.closes_at),
    }


def closed_data(election: Election, reason: str) -> dict:
    return {"election_id": election.ref, "closed_at": iso(election.closed_at), "reason": reason}


# --- publicación -------------------------------------------------------------


class Publisher(Protocol):
    def publish(self, routing_key: str, event_id: str, body: bytes) -> None:
        """Publica y espera la confirmación del broker; lanza excepción si falla."""

    def close(self) -> None: ...


class RabbitPublisher:
    """Publicador AMQP con publisher confirms; se reconecta perezosamente."""

    def __init__(self, uri: str, exchange: str):
        self._uri = uri
        self._exchange = exchange
        self._connection = None
        self._channel = None

    def _ensure_channel(self):
        import pika

        if self._channel is not None and self._channel.is_open:
            return self._channel
        self.close()
        parameters = pika.URLParameters(self._uri)
        parameters.connection_attempts = 1
        parameters.socket_timeout = 5
        self._connection = pika.BlockingConnection(parameters)
        channel = self._connection.channel()
        # Mismas opciones que declaran Analytics y Notifications: topic + durable.
        channel.exchange_declare(exchange=self._exchange, exchange_type="topic", durable=True)
        channel.confirm_delivery()
        self._channel = channel
        return channel

    def publish(self, routing_key: str, event_id: str, body: bytes) -> None:
        import pika

        channel = self._ensure_channel()
        # Con confirms, basic_publish lanza excepción si el broker hace nack. No se
        # usa ``mandatory``: un tipo sin consumidores (hoy ``election.opened``)
        # bloquearía el outbox. Las colas de los consumidores deben existir antes
        # (las declaran ellos mismos o la definición de RabbitMQ).
        try:
            channel.basic_publish(
                exchange=self._exchange,
                routing_key=routing_key,
                body=body,
                properties=pika.BasicProperties(
                    content_type="application/json",
                    delivery_mode=pika.DeliveryMode.Persistent,
                    message_id=event_id,
                    type=routing_key,
                    app_id=PRODUCER,
                ),
            )
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        connection, self._connection, self._channel = self._connection, None, None
        if connection is not None and connection.is_open:
            try:
                connection.close()
            except Exception:  # noqa: BLE001 - cierre de mejor esfuerzo
                pass


def publish_pending(session_factory: sessionmaker, publisher: Publisher, *, batch_size: int = 100) -> int:
    """Publica en orden los eventos pendientes. Devuelve cuántos se publicaron.

    Se detiene en el primer fallo para no alterar el orden de los eventos de una
    misma elección (p. ej. ``created`` antes que ``closed``).
    """
    published = 0
    with session_factory() as session:
        pending = session.scalars(
            select(OutboxEvent)
            .where(OutboxEvent.published_at.is_(None))
            .order_by(OutboxEvent.id)
            .limit(batch_size)
            # Varias réplicas del servicio no publican el mismo evento a la vez.
            .with_for_update(skip_locked=True)
        ).all()
        for event in pending:
            body = json.dumps(event.payload, separators=(",", ":"), ensure_ascii=False).encode()
            try:
                publisher.publish(event.event_type, str(event.event_id), body)
            except Exception as error:  # noqa: BLE001 - se reintenta en el siguiente ciclo
                event.attempts += 1
                event.last_error = f"{type(error).__name__}: {error}"[:500]
                log.warning("publishing %s %s failed: %s", event.event_type, event.event_id, error)
                break
            event.attempts += 1
            event.published_at = datetime.now(UTC)
            event.last_error = None
            published += 1
        session.commit()
    return published


class OutboxRelay:
    """Hilo que vacía el outbox y ejecuta tareas periódicas (cierre automático)."""

    def __init__(
        self,
        session_factory: sessionmaker,
        publisher: Publisher,
        *,
        interval_seconds: float,
        batch_size: int,
        periodic: Callable[[], None] | None = None,
    ):
        self._session_factory = session_factory
        self._publisher = publisher
        self._interval = interval_seconds
        self._batch_size = batch_size
        self._periodic = periodic
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="outbox-relay", daemon=True)
        self.healthy = False

    def start(self) -> None:
        self._thread.start()

    def notify(self) -> None:
        """Despierta al hilo tras un commit para publicar sin esperar el intervalo."""
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=10)
        self._publisher.close()

    def run_once(self) -> None:
        if self._periodic is not None:
            self._periodic()
        while publish_pending(self._session_factory, self._publisher, batch_size=self._batch_size) == self._batch_size:
            pass

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
                self.healthy = not self._has_backlog()
            except Exception:  # noqa: BLE001 - el hilo nunca debe morir
                self.healthy = False
                log.exception("outbox relay iteration failed")
            self._wake.wait(self._interval)
            self._wake.clear()

    def _has_backlog(self) -> bool:
        with self._session_factory() as session:
            return session.scalar(
                select(OutboxEvent.id).where(OutboxEvent.published_at.is_(None)).limit(1)
            ) is not None
