"""Punto de entrada del servicio Election: ``uvicorn app.main:app``."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import service
from app.api import router
from app.config import Settings, get_settings
from app.errors import install_error_handlers
from app.events import OutboxRelay, Publisher, RabbitPublisher
from app.keys import ServiceKeys, load_keys
from app.models import Base

log = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    *,
    session_factory: sessionmaker | None = None,
    keys: ServiceKeys | None = None,
    publisher: Publisher | None = None,
    start_relay: bool = True,
) -> FastAPI:
    """Construye la app. Los argumentos opcionales permiten inyectar dobles en pruebas."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = None
        if session_factory is None:
            engine = create_engine(settings.database_url, pool_pre_ping=True)
            if settings.auto_create_tables:
                Base.metadata.create_all(engine)
            app.state.session_factory = sessionmaker(engine, expire_on_commit=False)

        if keys is None:
            app.state.keys = load_keys(
                settings.keys_dir, urn_kek=settings.urn_kek, urn_key_bits=settings.urn_key_bits
            )

        relay = None
        if start_relay and (publisher is not None or settings.rabbitmq_uri):
            factory = app.state.session_factory

            def periodic() -> None:
                if settings.auto_close:
                    with factory() as session:
                        closed = service.close_expired_elections(session)
                    if closed:
                        log.info("auto-closed elections %s", ", ".join(closed))

            relay = OutboxRelay(
                factory,
                publisher or RabbitPublisher(settings.rabbitmq_uri, settings.exchange),
                interval_seconds=settings.relay_interval_seconds,
                batch_size=settings.relay_batch_size,
                periodic=periodic,
            )
            relay.start()
        app.state.relay = relay

        yield

        if relay is not None:
            relay.stop()
        if engine is not None:
            engine.dispose()

    app = FastAPI(title="Votaciones · Election", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.settings = settings
    app.state.relay = None
    if session_factory is not None:
        app.state.session_factory = session_factory
    if keys is not None:
        app.state.keys = keys

    install_error_handlers(app)
    app.include_router(router)
    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# pika registra un traceback por cada reconexión fallida; app.events ya avisa del fallo.
logging.getLogger("pika").setLevel(logging.CRITICAL)
app = create_app()
