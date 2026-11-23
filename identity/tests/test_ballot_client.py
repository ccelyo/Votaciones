"""Prueba el cliente gRPC contra un servidor gRPC real (en proceso) del contrato ballot.proto."""

from concurrent import futures
from datetime import datetime, timedelta, timezone

import grpc
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from pydantic import ValidationError

from app.clients.ballot_client import ElectionRegistration, GrpcBallotClient, TokenKey
from app.core.config import Settings
from app.core.errors import (
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


def issue_certificate(authority_key, authority_cert, common_name, dns_name, extended_usage, *, is_ca=False):
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = datetime.now(timezone.utc)
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(authority_cert.subject if authority_cert else subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=is_ca, path_length=None), critical=True)
    )
    if dns_name:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(dns_name)]), critical=False
        )
    if extended_usage:
        builder = builder.add_extension(x509.ExtendedKeyUsage(extended_usage), critical=False)
    certificate = builder.sign(authority_key or key, hashes.SHA256())
    private_key = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return key, certificate, private_key


@pytest.fixture
def mtls_server(servicer):
    ca_key, ca_cert, _ = issue_certificate(
        None, None, "test CA", None, None, is_ca=True
    )
    server_key, server_cert, _ = issue_certificate(
        ca_key, ca_cert, "localhost", "localhost", [ExtendedKeyUsageOID.SERVER_AUTH]
    )
    client_key, client_cert, client_key_pem = issue_certificate(
        ca_key, ca_cert, "identity", "identity", [ExtendedKeyUsageOID.CLIENT_AUTH]
    )
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    ballot_pb2_grpc.add_BallotAdminServiceServicer_to_server(servicer, server)
    port = server.add_secure_port(
        "127.0.0.1:0",
        grpc.ssl_server_credentials(
            [(server_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ), server_cert.public_bytes(serialization.Encoding.PEM))],
            root_certificates=ca_cert.public_bytes(serialization.Encoding.PEM),
            require_client_auth=True,
        ),
    )
    server.start()
    yield (
        f"localhost:{port}",
        ca_cert.public_bytes(serialization.Encoding.PEM),
        client_cert.public_bytes(serialization.Encoding.PEM),
        client_key_pem,
        ca_key,
        ca_cert,
    )
    server.stop(grace=None)


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


def test_mtls_requires_identity_and_trusted_ca():
    with pytest.raises(ValueError, match="mTLS requires trusted roots"):
        GrpcBallotClient("127.0.0.1:9091", use_tls=True)


def test_identity_mtls_listener_requires_complete_certificate_material():
    with pytest.raises(ValidationError, match="IDENTITY_TLS_REQUIRED"):
        Settings(tls_required=True)


def test_mtls_grpc_accepts_a_client_certificate_from_the_trusted_ca(mtls_server):
    address, ca, client_certificate, client_key, _, _ = mtls_server
    secure_client = GrpcBallotClient(
        address,
        timeout_seconds=2,
        use_tls=True,
        root_certificates=ca,
        private_key=client_key,
        certificate_chain=client_certificate,
    )
    try:
        assert secure_client.get_election_status("e1") == "open"
    finally:
        secure_client.close()


def test_mtls_grpc_rejects_missing_or_untrusted_client_certificates(mtls_server):
    address, ca, _, _, _, _ = mtls_server
    channel = grpc.secure_channel(address, grpc.ssl_channel_credentials(root_certificates=ca))
    try:
        stub = ballot_pb2_grpc.BallotAdminServiceStub(channel)
        with pytest.raises(grpc.RpcError) as missing_certificate:
            stub.GetElectionStatus(ballot_pb2.GetElectionStatusRequest(election_id="e1"), timeout=2)
        assert missing_certificate.value.code() in {
            grpc.StatusCode.UNAVAILABLE,
            grpc.StatusCode.DEADLINE_EXCEEDED,
        }
    finally:
        channel.close()

    other_ca_key, other_ca_cert, _ = issue_certificate(
        None, None, "untrusted CA", None, None, is_ca=True
    )
    _, wrong_client_cert, wrong_client_key = issue_certificate(
        other_ca_key,
        other_ca_cert,
        "identity",
        "identity",
        [ExtendedKeyUsageOID.CLIENT_AUTH],
    )
    secure_client = GrpcBallotClient(
        address,
        timeout_seconds=2,
        use_tls=True,
        root_certificates=ca,
        private_key=wrong_client_key,
        certificate_chain=wrong_client_cert.public_bytes(serialization.Encoding.PEM),
    )
    try:
        with pytest.raises(BallotUnavailable):
            secure_client.get_election_status("e1")
    finally:
        secure_client.close()
