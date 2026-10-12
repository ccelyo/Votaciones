"""base64url sin relleno, el mismo que usa `ballot` para los sobres de token."""

import base64
import binascii

from app.errors import InvalidRequest


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(value: str, field: str = "value") -> bytes:
    if not value or "=" in value or not value.isascii():
        raise InvalidRequest(f"{field} must be unpadded base64url")
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as error:
        raise InvalidRequest(f"{field} must be unpadded base64url") from error
