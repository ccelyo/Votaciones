"""Servicio de firma ciega (Blind Signature): ``uvicorn app.main:app``.

Contrato REST interno (solo lo llama Identity; el Gateway no lo expone):

* ``GET  /v1/keys/{election_id}``  clave pública RSA de la elección
* ``POST /v1/sign``                firma ciega de un mensaje ya cegado

Este servicio NO recibe ni guarda identidad del votante: solo ``election_id`` y el
mensaje cegado. Tampoco registra el mensaje ni la firma, de modo que no existe
nada que permita enlazar luego una papeleta con una persona.
"""

import base64
import binascii
import secrets

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app import blind_rsa
from app.config import Settings, get_settings
from app.key_store import InvalidElectionId, KeyStore


class SignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")  # rechaza p. ej. un `user_id` colado

    election_id: str = Field(min_length=1, max_length=128)
    blinded_message: str = Field(max_length=4096, description="base64url sin relleno")


def _b64url_decode(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError) as error:
        raise HTTPException(400, "blinded_message must be base64url") from error


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    if not settings.api_key.strip():
        # No incluir valores de configuración en el mensaje.
        raise RuntimeError(
            "BLINDSIG_API_KEY is required: set the shared secret that Identity sends "
            "in the X-Internal-Token header"
        )
    app = FastAPI(title="Votaciones · Blind Signature")
    app.state.store = KeyStore(settings.keys_dir)

    def authorize(x_internal_token: str | None = Header(default=None)) -> None:
        # Siempre se exige; compare_digest evita filtrar el secreto por tiempo de respuesta.
        provided = (x_internal_token or "").encode()
        if not secrets.compare_digest(provided, settings.api_key.encode()):
            raise HTTPException(401, "invalid internal token")

    def election_key(request: Request, election_id: str):
        try:
            return request.app.state.store.get_or_create(election_id)
        except InvalidElectionId as error:
            raise HTTPException(400, str(error)) from error

    @app.get("/v1/keys/{election_id}", dependencies=[Depends(authorize)])
    def get_key(election_id: str, request: Request) -> dict:
        key = election_key(request, election_id)
        return {
            "election_id": election_id,
            "kid": key.kid,
            "variant": blind_rsa.VARIANT,
            "public_key_der": _b64url(key.public_der),
        }

    @app.post("/v1/sign", dependencies=[Depends(authorize)])
    def sign(body: SignRequest, request: Request) -> dict:
        key = election_key(request, body.election_id)
        try:
            signature = blind_rsa.blind_sign(key.private, _b64url_decode(body.blinded_message))
        except blind_rsa.BlindSignError as error:
            raise HTTPException(400, str(error)) from error
        return {
            "kid": key.kid,
            "variant": blind_rsa.VARIANT,
            "blind_signature": _b64url(signature),
        }

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    return app



def __getattr__(name: str):
    # `uvicorn app.main:app`: la app se crea al pedirla, no al importar el módulo, así que
    # importar `create_app` (p. ej. en pruebas) no exige variables de entorno.
    if name == "app":
        return create_app()
    raise AttributeError(name)
