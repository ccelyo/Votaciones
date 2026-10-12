"""Punto de entrada del servicio de identidad: ``uvicorn app.main:app``."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api import router
from app.ballot_client import BallotGateway, GrpcBallotClient
from app.config import Settings, get_settings
from app.errors import install_error_handlers
from app.keys import IdentityKeys, load_keys
from app.models import Base


def create_app(
    settings: Settings | None = None,
    *,
    session_factory: sessionmaker | None = None,
    ballot: BallotGateway | None = None,
    keys: IdentityKeys | None = None,
) -> FastAPI:
    """Construye la app. Los argumentos opcionales permiten inyectar dobles en pruebas."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = None
        owned_ballot = None
        if session_factory is None:
            engine = create_engine(settings.database_url, pool_pre_ping=True)
            Base.metadata.create_all(engine)  # Prototype 1: sin migraciones.
            app.state.session_factory = sessionmaker(engine, expire_on_commit=False)
        if ballot is None:
            owned_ballot = GrpcBallotClient(
                settings.ballot_grpc_addr, settings.ballot_grpc_timeout_seconds
            )
            app.state.ballot = owned_ballot
        if keys is None:
            app.state.keys = load_keys(settings.keys_dir)
        yield
        if owned_ballot is not None:
            owned_ballot.close()
        if engine is not None:
            engine.dispose()

    app = FastAPI(title="Votaciones · Identidad", lifespan=lifespan)
    app.state.settings = settings
    if session_factory is not None:
        app.state.session_factory = session_factory
    if ballot is not None:
        app.state.ballot = ballot
    if keys is not None:
        app.state.keys = keys
    install_error_handlers(app)
    app.include_router(router)
    return app


app = create_app()
