package server

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/ccelyo/Votaciones/ballot/internal/election"
	"github.com/ccelyo/Votaciones/ballot/internal/pb"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

type testGRPCServer struct {
	client  pb.BallotAdminServiceClient
	health  grpc_health_v1.HealthClient
	store   *election.MemoryStore
	cleanup func()
}

func newTestGRPCServer(t *testing.T) testGRPCServer {
	t.Helper()
	now := func() time.Time { return time.Unix(2_000_000_100, 0).UTC() }
	return newTestGRPCServerWithClock(t, now)
}

func newTestGRPCServerWithClock(t *testing.T, now func() time.Time, counters ...election.ParticipationCounter) testGRPCServer {
	t.Helper()
	store := election.NewMemoryStoreWithClock(now)
	admin := NewAdminService(store, now, counters...)
	grpcServer := NewGRPCServer(admin)
	listener := bufconn.Listen(1024 * 1024)
	go func() { _ = grpcServer.Serve(listener) }()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := grpc.NewClient(
		"passthrough:///bufnet",
		grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.MaxCallSendMsgSize(2*MaxMessageSize)),
	)
	if err != nil {
		t.Fatal(err)
	}
	conn.Connect()
	if err := waitForReady(ctx, conn); err != nil {
		t.Fatal(err)
	}
	return testGRPCServer{
		client: pb.NewBallotAdminServiceClient(conn),
		health: grpc_health_v1.NewHealthClient(conn),
		store:  store,
		cleanup: func() {
			_ = conn.Close()
			grpcServer.GracefulStop()
			_ = listener.Close()
		},
	}
}

func waitForReady(ctx context.Context, conn *grpc.ClientConn) error {
	for {
		state := conn.GetState()
		if state == connectivity.Ready {
			return nil
		}
		if !conn.WaitForStateChange(ctx, state) {
			return ctx.Err()
		}
	}
}

func validRegisterRequest(t *testing.T, electionID string) *pb.RegisterElectionRequest {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicKeyDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return &pb.RegisterElectionRequest{
		ElectionId:          electionID,
		Options:             []string{"option-a", "option-b"},
		EncryptionPublicKey: []byte("opaque-election-public-key"),
		TokenVerificationKeys: []*pb.TokenVerificationKey{{
			Kid:              "key-1",
			PublicKeyDer:     publicKeyDER,
			SignatureVariant: token.RSABSSASHA384PSSRandomized,
		}},
		OpensAtUnixSeconds:          2_000_000_000,
		ClosesAtUnixSeconds:         2_000_003_600,
		SignedParameters:            []byte("canonical signed parameter bytes"),
		ParameterSigningKeyId:       "identity-key-1",
		ParameterSignatureAlgorithm: "ed25519",
		ParameterSignature:          []byte("identity-signature"),
	}
}

func TestAdminRPCsHappyPathAndHealth(t *testing.T) {
	server := newTestGRPCServer(t)
	defer server.cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	missing, err := server.client.GetElectionStatus(ctx, &pb.GetElectionStatusRequest{ElectionId: "missing"})
	if err != nil || missing.Status != pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND {
		t.Fatalf("missing GetElectionStatus = (%v, %v), want NOT_FOUND", missing, err)
	}

	request := validRegisterRequest(t, "election-1")
	registered, err := server.client.RegisterElection(ctx, request)
	if err != nil || !registered.Created {
		t.Fatalf("first RegisterElection = (%v, %v), want created", registered, err)
	}
	registered, err = server.client.RegisterElection(ctx, request)
	if err != nil || registered.Created {
		t.Fatalf("idempotent RegisterElection = (%v, %v), want created=false", registered, err)
	}

	statusResponse, err := server.client.GetElectionStatus(ctx, &pb.GetElectionStatusRequest{ElectionId: "election-1"})
	if err != nil || statusResponse.Status != pb.ElectionStatus_ELECTION_STATUS_OPEN {
		t.Fatalf("open status = (%v, %v), want OPEN", statusResponse, err)
	}
	if err := server.store.AddParticipation(ctx, "election-1"); err != nil {
		t.Fatal(err)
	}
	count, err := server.client.CountBallots(ctx, &pb.CountBallotsRequest{ElectionId: "election-1"})
	if err != nil || count.TotalBallots != 1 {
		t.Fatalf("CountBallots = (%v, %v), want 1", count, err)
	}

	for i := 0; i < 2; i++ {
		closed, err := server.client.CloseElection(ctx, &pb.CloseElectionRequest{ElectionId: "election-1"})
		if err != nil || closed.Status != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
			t.Fatalf("CloseElection call %d = (%v, %v), want CLOSED", i+1, closed, err)
		}
	}
	statusResponse, err = server.client.GetElectionStatus(ctx, &pb.GetElectionStatusRequest{ElectionId: "election-1"})
	if err != nil || statusResponse.Status != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
		t.Fatalf("status after close = (%v, %v), want CLOSED", statusResponse, err)
	}

	health, err := server.health.Check(ctx, &grpc_health_v1.HealthCheckRequest{Service: ""})
	if err != nil || health.Status != grpc_health_v1.HealthCheckResponse_SERVING {
		t.Fatalf("health Check = (%v, %v), want SERVING", health, err)
	}
}

func TestAdminRPCErrorCodes(t *testing.T) {
	server := newTestGRPCServer(t)
	defer server.cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if _, err := server.client.RegisterElection(ctx, &pb.RegisterElectionRequest{}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid RegisterElection code = %v, want InvalidArgument", status.Code(err))
	}
	if _, err := server.client.CloseElection(ctx, &pb.CloseElectionRequest{ElectionId: "missing"}); status.Code(err) != codes.NotFound {
		t.Fatalf("missing CloseElection code = %v, want NotFound", status.Code(err))
	}
	if _, err := server.client.CountBallots(ctx, &pb.CountBallotsRequest{ElectionId: "missing"}); status.Code(err) != codes.NotFound {
		t.Fatalf("missing CountBallots code = %v, want NotFound", status.Code(err))
	}

	request := validRegisterRequest(t, "election-1")
	if _, err := server.client.RegisterElection(ctx, request); err != nil {
		t.Fatal(err)
	}
	conflict := validRegisterRequest(t, "election-1")
	if _, err := server.client.RegisterElection(ctx, conflict); status.Code(err) != codes.AlreadyExists {
		t.Fatalf("conflicting RegisterElection code = %v, want AlreadyExists", status.Code(err))
	}
	request.ClosesAtUnixSeconds = request.OpensAtUnixSeconds
	if _, err := server.client.RegisterElection(ctx, request); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid election dates code = %v, want InvalidArgument", status.Code(err))
	}
}

func TestAdminRPCAddsRotatedTokenVerificationKey(t *testing.T) {
	server := newTestGRPCServer(t)
	defer server.cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := server.client.RegisterElection(ctx, validRegisterRequest(t, "election-rotate")); err != nil {
		t.Fatal(err)
	}
	newKey := validRegisterRequest(t, "unused").TokenVerificationKeys[0]
	newKey.Kid = "key-2"
	request := &pb.AddTokenVerificationKeyRequest{ElectionId: "election-rotate", Key: newKey}
	response, err := server.client.AddTokenVerificationKey(ctx, request)
	if err != nil || !response.Created {
		t.Fatalf("first AddTokenVerificationKey = (%v, %v), want created", response, err)
	}
	response, err = server.client.AddTokenVerificationKey(ctx, request)
	if err != nil || response.Created {
		t.Fatalf("idempotent AddTokenVerificationKey = (%v, %v), want created=false", response, err)
	}
	if _, ok, err := server.store.ResolveTokenKey(ctx, "election-rotate", "key-2"); err != nil || !ok {
		t.Fatalf("ResolveTokenKey after rotation = (ok=%v, err=%v), want true", ok, err)
	}

	conflictingKey := validRegisterRequest(t, "unused-2").TokenVerificationKeys[0]
	conflictingKey.Kid = "key-2"
	if _, err := server.client.AddTokenVerificationKey(ctx, &pb.AddTokenVerificationKeyRequest{ElectionId: "election-rotate", Key: conflictingKey}); status.Code(err) != codes.AlreadyExists {
		t.Fatalf("conflicting key ID code = %v, want AlreadyExists", status.Code(err))
	}
	if _, err := server.client.AddTokenVerificationKey(ctx, &pb.AddTokenVerificationKeyRequest{ElectionId: "missing", Key: newKey}); status.Code(err) != codes.NotFound {
		t.Fatalf("missing election code = %v, want NotFound", status.Code(err))
	}
	if _, err := server.client.CloseElection(ctx, &pb.CloseElectionRequest{ElectionId: "election-rotate"}); err != nil {
		t.Fatal(err)
	}
	if _, err := server.client.AddTokenVerificationKey(ctx, request); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("closed election key rotation code = %v, want FailedPrecondition", status.Code(err))
	}
}

func TestAdminRPCRejectsOversizedMessage(t *testing.T) {
	server := newTestGRPCServer(t)
	defer server.cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	request := validRegisterRequest(t, "election-large")
	request.SignedParameters = make([]byte, MaxMessageSize+1)
	if _, err := server.client.RegisterElection(ctx, request); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("oversized request code = %v, want ResourceExhausted", status.Code(err))
	}
}

func TestAdminRPCUsesRequestContext(t *testing.T) {
	server := newTestGRPCServer(t)
	defer server.cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := server.client.GetElectionStatus(ctx, &pb.GetElectionStatusRequest{ElectionId: "missing"})
	if !errors.Is(err, context.Canceled) && status.Code(err) != codes.Canceled {
		t.Fatalf("canceled RPC error = %v, want Canceled", err)
	}
}

func TestDeadlineInterceptorAddsRequestDeadline(t *testing.T) {
	interceptor := deadlineInterceptor(15 * time.Millisecond)
	_, err := interceptor(context.Background(), nil, &grpc.UnaryServerInfo{}, func(ctx context.Context, _ any) (any, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("interceptor did not add a deadline")
		}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("interceptor error = %v, want context.DeadlineExceeded", err)
	}
}
