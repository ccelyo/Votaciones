"""Cliente gRPC de identidad hacia `ballot` (``BallotAdminService``).

Contrato: ``proto/ballot.proto``. El Prototype 1 usa un canal sin cifrar hacia un
listener interno; mTLS queda pendiente (M2). Ningún método expone papeletas,
votos ni resultados: solo parámetros públicos, estado y participación.
"""

from dataclasses import dataclass
from typing import Protocol

import grpc

from app.errors import (
    BallotUnavailable,
    ElectionAlreadyExists,
    ElectionNotFound,
    ElectionNotOpen,
)
from app.pb import ballot_pb2, ballot_pb2_grpc

_STATUS_NAMES = {
    ballot_pb2.ELECTION_STATUS_OPEN: "open",
    ballot_pb2.ELECTION_STATUS_CLOSED: "closed",
    ballot_pb2.ELECTION_STATUS_NOT_FOUND: "not_found",
}


@dataclass(frozen=True)
class TokenKey:
    """Clave pública RSA (DER SubjectPublicKeyInfo) que `ballot` usa para verificar tokens."""

    kid: str
    public_key_der: bytes
    signature_variant: str


@dataclass(frozen=True)
class ElectionRegistration:
    election_id: str
    options: list[str]
    encryption_public_key: bytes
    token_keys: list[TokenKey]
    opens_at: int
    closes_at: int
    signed_parameters: bytes
    parameter_signing_key_id: str
    parameter_signature_algorithm: str
    parameter_signature: bytes


class BallotGateway(Protocol):
    def register_election(self, registration: ElectionRegistration) -> bool: ...
    def add_token_verification_key(self, election_id: str, key: TokenKey) -> bool: ...
    def close_election(self, election_id: str) -> str: ...
    def get_election_status(self, election_id: str) -> str: ...
    def count_ballots(self, election_id: str) -> int: ...


def _to_pb_key(key: TokenKey) -> ballot_pb2.TokenVerificationKey:
    return ballot_pb2.TokenVerificationKey(
        kid=key.kid,
        public_key_der=key.public_key_der,
        signature_variant=key.signature_variant,
    )


def _translate(error: grpc.RpcError) -> Exception:
    code = error.code()
    if code == grpc.StatusCode.NOT_FOUND:
        return ElectionNotFound("election is not registered in ballot")
    if code == grpc.StatusCode.ALREADY_EXISTS:
        return ElectionAlreadyExists("ballot already has this election with different parameters")
    if code == grpc.StatusCode.FAILED_PRECONDITION:
        return ElectionNotOpen("ballot reports the election is closed")
    # UNAVAILABLE, DEADLINE_EXCEEDED, INVALID_ARGUMENT (bug nuestro) e INTERNAL.
    return BallotUnavailable(f"ballot service error ({code.name})")


class GrpcBallotClient:
    def __init__(self, address: str, timeout_seconds: float = 5.0):
        self._channel = grpc.insecure_channel(address)
        self._stub = ballot_pb2_grpc.BallotAdminServiceStub(self._channel)
        self._timeout = timeout_seconds

    def close(self) -> None:
        self._channel.close()

    def _call(self, method, request):
        try:
            return method(request, timeout=self._timeout)
        except grpc.RpcError as error:
            raise _translate(error) from error

    def register_election(self, registration: ElectionRegistration) -> bool:
        """Devuelve True si se creó; False si ya existía idéntica (idempotente)."""
        response = self._call(
            self._stub.RegisterElection,
            ballot_pb2.RegisterElectionRequest(
                election_id=registration.election_id,
                options=registration.options,
                encryption_public_key=registration.encryption_public_key,
                token_verification_keys=[_to_pb_key(key) for key in registration.token_keys],
                opens_at_unix_seconds=registration.opens_at,
                closes_at_unix_seconds=registration.closes_at,
                signed_parameters=registration.signed_parameters,
                parameter_signing_key_id=registration.parameter_signing_key_id,
                parameter_signature_algorithm=registration.parameter_signature_algorithm,
                parameter_signature=registration.parameter_signature,
            ),
        )
        return response.created

    def add_token_verification_key(self, election_id: str, key: TokenKey) -> bool:
        """Registra un nuevo `kid` sin invalidar tokens emitidos con claves anteriores."""
        response = self._call(
            self._stub.AddTokenVerificationKey,
            ballot_pb2.AddTokenVerificationKeyRequest(
                election_id=election_id, key=_to_pb_key(key)
            ),
        )
        return response.created

    def close_election(self, election_id: str) -> str:
        """Cierre irreversible; repetirlo sigue siendo exitoso. Devuelve el estado."""
        response = self._call(
            self._stub.CloseElection, ballot_pb2.CloseElectionRequest(election_id=election_id)
        )
        return _STATUS_NAMES.get(response.status, "unknown")

    def get_election_status(self, election_id: str) -> str:
        """``open``, ``closed`` o ``not_found``."""
        response = self._call(
            self._stub.GetElectionStatus,
            ballot_pb2.GetElectionStatusRequest(election_id=election_id),
        )
        return _STATUS_NAMES.get(response.status, "unknown")

    def count_ballots(self, election_id: str) -> int:
        """Participación (total de papeletas). Nunca devuelve contenido de votos."""
        response = self._call(
            self._stub.CountBallots, ballot_pb2.CountBallotsRequest(election_id=election_id)
        )
        return response.total_ballots
