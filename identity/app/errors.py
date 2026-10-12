"""Errores de dominio y su traducción a respuestas HTTP uniformes."""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class IdentityError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str | None = None):
        self.message = message or self.code.replace("_", " ")
        super().__init__(self.message)


class InvalidRequest(IdentityError):
    status_code, code = 400, "invalid_request"


class Unauthenticated(IdentityError):
    status_code, code = 401, "unauthenticated"


class Forbidden(IdentityError):
    status_code, code = 403, "forbidden"


class NotEligible(Forbidden):
    code = "not_in_voter_roll"


class ElectionNotFound(IdentityError):
    status_code, code = 404, "election_not_found"


class ElectionAlreadyExists(IdentityError):
    status_code, code = 409, "election_already_exists"


class ElectionNotOpen(IdentityError):
    status_code, code = 409, "election_not_open"


class TokenAlreadyIssued(IdentityError):
    status_code, code = 409, "token_already_issued"


class BallotUnavailable(IdentityError):
    """`ballot` no responde o rechazó una operación válida."""

    status_code, code = 502, "ballot_unavailable"


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(IdentityError)
    async def _identity_error(_: Request, error: IdentityError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={"error": {"code": error.code, "message": error.message}},
        )
