"""Codificación base64url sin relleno y fechas RFC 3339 en UTC."""

import base64
from datetime import UTC, datetime


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def iso(value: datetime | None) -> str | None:
    """``2026-10-20T21:00:00Z``: el formato que esperan Analytics y Notifications."""
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
