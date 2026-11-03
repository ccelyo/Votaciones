"""Cliente REST de Blind Signature (conector ``Identity → Blind Signature``).

Identity solo envía ``election_id`` y el mensaje ya cegado. NUNCA envía el
identificador del votante: así el servicio de firma no puede saber a quién firma.
"""

from dataclasses import dataclass
from typing import Protocol

import httpx

from app.clients.ballot_client import TokenKey
from app.core.encoding import b64url_decode, b64url_encode
from app.core.errors import BlindSignatureUnavailable, InvalidRequest


@dataclass(frozen=True)
class BlindSignature:
    kid: str
    variant: str
    blind_signature: bytes


class BlindSigner(Protocol):
    def token_key(self, election_id: str) -> TokenKey: ...

    def sign(self, election_id: str, blinded_message: bytes) -> BlindSignature: ...


class HttpBlindSigner:
    def __init__(self, base_url: str, timeout: float = 5.0, api_key: str = ""):
        headers = {"X-Internal-Token": api_key} if api_key else {}
        self._http = httpx.Client(base_url=base_url, timeout=timeout, headers=headers)

    def close(self) -> None:
        self._http.close()

    def _call(self, method: str, url: str, **kwargs) -> dict:
        try:
            response = self._http.request(method, url, **kwargs)
        except httpx.HTTPError as error:
            raise BlindSignatureUnavailable("blind signature service unreachable") from error
        if response.status_code == 400:
            raise InvalidRequest(response.json().get("detail", "invalid blinded message"))
        if response.status_code != 200:
            raise BlindSignatureUnavailable(
                f"blind signature service error ({response.status_code})"
            )
        return response.json()

    def token_key(self, election_id: str) -> TokenKey:
        body = self._call("GET", f"/v1/keys/{election_id}")
        return TokenKey(
            kid=body["kid"],
            public_key_der=b64url_decode(body["public_key_der"], "public_key_der"),
            signature_variant=body["variant"],
        )

    def sign(self, election_id: str, blinded_message: bytes) -> BlindSignature:
        body = self._call(
            "POST",
            "/v1/sign",
            json={"election_id": election_id, "blinded_message": b64url_encode(blinded_message)},
        )
        return BlindSignature(
            kid=body["kid"],
            variant=body["variant"],
            blind_signature=b64url_decode(body["blind_signature"], "blind_signature"),
        )
