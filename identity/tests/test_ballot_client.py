"""Prueba el cliente gRPC contra un servidor gRPC real (en proceso) del contrato ballot.proto."""

from concurrent import futures

import grpc
import pytest

from app.ballot_client import ElectionRegistration, GrpcBallotClient, TokenKey
from app.errors import (
    BallotUnavailable,
    ElectionAlreadyExists,
    ElectionNotFound,
    ElectionNotOpen,
)
from app.pb import ballot_pb2, ballot_pb2_grpc


class FakeBallotServicer(ballot_pb2_grpc.BallotAdminServiceServicer):
    def __init__(self):
        self.registered: list[ballot_pb2.RegisterElectionRequest] = []
        self.fail_with: grpc.StatusCode | None = None
        self.status = ballot_pb2.ELECTION_STATUS_OPEN

    def _maybe_fail(self, context):
        if self.fail_with is not None:
            context.abort(self.fail_with, "boom")

    def RegisterElection(self, request, context):
        self._maybe_fail(context)
        created = all(r.election_id != request.election_id for r in self.registered)
        self.registered.append(request)
        return ballot_pb2.RegisterElectionResponse(created=created)

    def AddTokenVerificationKey(self, request, context):
        self._maybe_fail(context)
        self.added = request
        return ballot_pb2.AddTokenVerificationKeyResponse(created=True)

    def CloseElection(self, request, context):
        self._maybe_fail(context)
        return ballot_pb2.ElectionStatusResponse(status=ballot_pb2.ELECTION_STATUS_CLOSED)

    def GetElectionStatus(self, request, context):
        self._maybe_fail(context)
        return ballot_pb2.ElectionStatusResponse(status=self.status)

    def CountBallots(self, request, context):
        self._maybe_fail(context)
        return ballot_pb2.CountBallotsResponse(total_ballots=42)


@pytest.fixture
def servicer():
    return FakeBallotServicer()


@pytest.fixture
def client(servicer):
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    ballot_pb2_grpc.add_BallotAdminServiceServicer_to_server(servicer, server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    grpc_client = GrpcBallotClient(f"127.0.0.1:{port}", timeout_seconds=2)
    yield grpc_client
    grpc_client.close()
    server.stop(grace=None)


def registration() -> ElectionRegistration:
    return ElectionRegistration(
        election_id="e1",
        options=["A", "B"],
        encryption_public_key=b"pub",
        token_keys=[TokenKey("kid1", b"der", "RSABSSA-SHA384-PSS-Randomized")],
        opens_at=100,
        closes_at=200,
        signed_parameters=b"params",
        parameter_signing_key_id="pk1",
        parameter_signature_algorithm="Ed25519",
        parameter_signature=b"sig",
    )


def test_register_election_sends_every_contract_field(client, servicer):
    assert client.register_election(registration()) is True
    assert client.register_election(registration()) is False  # idempotente

    request = servicer.registered[0]
    assert request.election_id == "e1"
    assert list(request.options) == ["A", "B"]
    assert request.encryption_public_key == b"pub"
    assert request.token_verification_keys[0].kid == "kid1"
    assert request.token_verification_keys[0].public_key_der == b"der"
    assert request.token_verification_keys[0].signature_variant == "RSABSSA-SHA384-PSS-Randomized"
    assert (request.opens_at_unix_seconds, request.closes_at_unix_seconds) == (100, 200)
    assert request.signed_parameters == b"params"
    assert request.parameter_signing_key_id == "pk1"
    assert request.parameter_signature_algorithm == "Ed25519"
    assert request.parameter_signature == b"sig"


def test_add_token_verification_key(client, servicer):
    assert client.add_token_verification_key("e1", TokenKey("kid2", b"der2", "v")) is True
    assert servicer.added.election_id == "e1" and servicer.added.key.kid == "kid2"


def test_close_status_and_count(client, servicer):
    assert client.close_election("e1") == "closed"
    assert client.get_election_status("e1") == "open"
    servicer.status = ballot_pb2.ELECTION_STATUS_NOT_FOUND
    assert client.get_election_status("e1") == "not_found"
    assert client.count_ballots("e1") == 42


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        (grpc.StatusCode.NOT_FOUND, ElectionNotFound),
        (grpc.StatusCode.ALREADY_EXISTS, ElectionAlreadyExists),
        (grpc.StatusCode.FAILED_PRECONDITION, ElectionNotOpen),
        (grpc.StatusCode.INVALID_ARGUMENT, BallotUnavailable),
        (grpc.StatusCode.INTERNAL, BallotUnavailable),
    ],
)
def test_grpc_errors_map_to_domain_errors(client, servicer, code, expected):
    servicer.fail_with = code
    with pytest.raises(expected):
        client.close_election("e1")


def test_unreachable_ballot_is_reported_as_unavailable():
    unreachable = GrpcBallotClient("127.0.0.1:1", timeout_seconds=0.5)
    try:
        with pytest.raises(BallotUnavailable):
            unreachable.get_election_status("e1")
    finally:
        unreachable.close()
