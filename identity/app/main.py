"""Punto de entrada del servicio de identidad: ``uvicorn app.main:app``."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api import router
from app.clients.ballot_client import BallotGateway, GrpcBallotClient
from app.clients.blind_signature import BlindSigner, HttpBlindSigner
from app.core.config import Settings, get_settings
from app.core.errors import install_error_handlers
from app.core.keys import IdentityKeys, load_keys
from app.db.census import CensusBase
from app.db.models import Base


def create_app(
    settings: Settings | None = None,
    *,
    session_factory: sessionmaker | None = None,
    census_session_factory: sessionmaker | None = None,
    ballot: BallotGateway | None = None,
    blind_signer: BlindSigner | None = None,
    keys: IdentityKeys | None = None,
) -> FastAPI:
    """Construye la app. Los argumentos opcionales permiten inyectar dobles en pruebas."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = None
        census_engine = None
        owned_ballot = None
        owned_signer = None

        if session_factory is None:
            engine = create_engine(
                settings.database_url,
                pool_pre_ping=True,
            )

            if settings.auto_create_tables:
                # Solo desarrollo; la fuente de verdad es schema.sql.
                Base.metadata.create_all(engine)

            app.state.session_factory = sessionmaker(
                engine,
                expire_on_commit=False,
            )

        if census_session_factory is None:
            # Sin URL propia, Census comparte la base de Identity (solo desarrollo).
            census_engine = create_engine(
                settings.census_database_url or settings.database_url,
                pool_pre_ping=True,
            )
            if settings.auto_create_tables:
                CensusBase.metadata.create_all(census_engine)
            app.state.census_session_factory = sessionmaker(
                census_engine, expire_on_commit=False
            )

        if blind_signer is None:
            owned_signer = HttpBlindSigner(
                settings.blind_signature_url,
                settings.blind_signature_timeout_seconds,
                settings.blind_signature_api_key,
            )
            app.state.blind_signer = owned_signer

        if ballot is None:
            owned_ballot = GrpcBallotClient(
                settings.ballot_grpc_addr,
                settings.ballot_grpc_timeout_seconds,
                use_tls=settings.ballot_grpc_tls,
            )
            app.state.ballot = owned_ballot

        if keys is None:
            app.state.keys = load_keys(settings.keys_dir)

        yield

        if owned_ballot is not None:
            owned_ballot.close()

        if owned_signer is not None:
            owned_signer.close()

        if census_engine is not None:
            census_engine.dispose()

        if engine is not None:
            engine.dispose()

    app = FastAPI(
        title="Votaciones · Identidad",
        lifespan=lifespan,
    )

    # Permite que el frontend acceda a Identity desde otro origen
    # (IDENTITY_ALLOWED_ORIGINS).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.settings = settings

    if session_factory is not None:
        app.state.session_factory = session_factory

    if census_session_factory is not None:
        app.state.census_session_factory = census_session_factory

    if ballot is not None:
        app.state.ballot = ballot

    if blind_signer is not None:
        app.state.blind_signer = blind_signer

    if keys is not None:
        app.state.keys = keys

    install_error_handlers(app)
    app.include_router(router)

    return app


app = create_app()