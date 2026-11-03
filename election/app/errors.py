"""Errores de dominio y su traducción a respuestas HTTP uniformes.

Formato común con identity: ``{"error": {"code": "...", "message": "..."}}``.
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ElectionError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str | None = None):
        self.message = message or self.code.replace("_", " ")
        super().__init__(self.message)


class InvalidRequest(ElectionError):
    status_code, code = 400, "invalid_request"


class Unauthenticated(ElectionError):
    status_code, code = 401, "unauthenticated"


class Forbidden(ElectionError):
    status_code, code = 403, "forbidden"


class ElectionNotFound(ElectionError):
    status_code, code = 404, "election_not_found"


class InvalidTransition(ElectionError):
    """La operación no está permitida en el estado actual de la elección."""

    status_code, code = 409, "invalid_state"


class UrnKeyUnavailable(ElectionError):
    status_code, code = 409, "urn_key_unavailable"


def _body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ElectionError)
    async def _election_error(_: Request, error: ElectionError) -> JSONResponse:
        return JSONResponse(status_code=error.status_code, content=_body(error.code, error.message))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, error: RequestValidationError) -> JSONResponse:
        first = error.errors()[0] if error.errors() else {}
        where = ".".join(str(part) for part in first.get("loc", ()) if part != "body")
        message = f"{where}: {first.get('msg', 'invalid value')}" if where else "invalid request"
        return JSONResponse(status_code=422, content=_body("invalid_request", message))
