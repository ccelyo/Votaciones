// Package server exposes ballot's private election-administration gRPC API.
package server

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ccelyo/Votaciones/ballot/internal/election"
	"github.com/ccelyo/Votaciones/ballot/internal/pb"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
)

const (
	// MaxMessageSize bounds all gRPC request and response messages.
	MaxMessageSize = 1 << 20
	requestTimeout = 5 * time.Second
	maxOptions     = 100
	maxTokenKeys   = 8
)

// AdminService handles registration, closure, participation count and status.
type AdminService struct {
	pb.UnimplementedBallotAdminServiceServer
	store   election.Store
	counter election.ParticipationCounter
	now     func() time.Time
}

// NewAdminService constructs the gRPC API service.
func NewAdminService(store election.Store, now func() time.Time, counters ...election.ParticipationCounter) *AdminService {
	if now == nil {
		now = time.Now
	}
	service := &AdminService{store: store, now: now}
	if len(counters) > 0 {
		service.counter = counters[0]
	} else if counter, ok := store.(election.ParticipationCounter); ok {
		service.counter = counter
	}
	return service
}

// RegisterElection stores the signed public parameters and token verification keys.
func (s *AdminService) RegisterElection(ctx context.Context, request *pb.RegisterElectionRequest) (*pb.RegisterElectionResponse, error) {
	config, err := electionFromRequest(request)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid election registration")
	}
	created, err := s.store.Register(ctx, config)
	if err != nil {
		if errors.Is(err, election.ErrRegistrationConflict) {
			return nil, status.Error(codes.AlreadyExists, "election is already registered with different parameters")
		}
		if errors.Is(err, election.ErrInvalidElection) {
			return nil, status.Error(codes.InvalidArgument, "invalid election registration")
		}
		return nil, mapStoreError(err, "register election")
	}
	return &pb.RegisterElectionResponse{Created: created}, nil
}

// AddTokenVerificationKey adds a new key ID while preserving keys used for
// previously issued tokens. Reusing a key ID with different key material fails.
func (s *AdminService) AddTokenVerificationKey(ctx context.Context, request *pb.AddTokenVerificationKeyRequest) (*pb.AddTokenVerificationKeyResponse, error) {
	if request == nil || !validText(request.GetElectionId(), 128) {
		return nil, status.Error(codes.InvalidArgument, "invalid token key registration")
	}
	key, err := tokenKeyFromRequest(request.GetKey())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid token key registration")
	}
	created, err := s.store.AddTokenVerificationKey(ctx, request.GetElectionId(), key)
	if err != nil {
		switch {
		case errors.Is(err, election.ErrElectionNotFound):
			return nil, status.Error(codes.NotFound, "election not found")
		case errors.Is(err, election.ErrTokenKeyConflict):
			return nil, status.Error(codes.AlreadyExists, "token key ID is already registered")
		case errors.Is(err, election.ErrInvalidElection):
			return nil, status.Error(codes.InvalidArgument, "invalid token key registration")
		case errors.Is(err, token.ErrElectionClosed):
			return nil, status.Error(codes.FailedPrecondition, "election is closed")
		default:
			return nil, mapStoreError(err, "add token verification key")
		}
	}
	return &pb.AddTokenVerificationKeyResponse{Created: created}, nil
}

// CloseElection irreversibly closes an election. Repeated calls remain successful.
func (s *AdminService) CloseElection(ctx context.Context, request *pb.CloseElectionRequest) (*pb.ElectionStatusResponse, error) {
	if request == nil || !validText(request.GetElectionId(), 128) {
		return nil, status.Error(codes.InvalidArgument, "invalid election identifier")
	}
	electionStatus, err := s.store.Close(ctx, request.GetElectionId(), s.now().UTC())
	if err != nil {
		if errors.Is(err, election.ErrElectionNotFound) {
			return nil, status.Error(codes.NotFound, "election not found")
		}
		return nil, mapStoreError(err, "close election")
	}
	return &pb.ElectionStatusResponse{Status: electionStatus}, nil
}

// CountBallots returns participation only.
func (s *AdminService) CountBallots(ctx context.Context, request *pb.CountBallotsRequest) (*pb.CountBallotsResponse, error) {
	if request == nil || !validText(request.GetElectionId(), 128) {
		return nil, status.Error(codes.InvalidArgument, "invalid election identifier")
	}
	electionStatus, err := s.store.Status(ctx, request.GetElectionId(), s.now().UTC())
	if err != nil {
		return nil, mapStoreError(err, "check election for count")
	}
	if electionStatus == pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND {
		return nil, status.Error(codes.NotFound, "election not found")
	}
	var count uint64
	if s.counter != nil {
		count, err = s.counter.CountBallots(ctx, request.GetElectionId())
	} else {
		count, err = s.store.Count(ctx, request.GetElectionId())
	}
	if err != nil {
		if errors.Is(err, election.ErrElectionNotFound) {
			return nil, status.Error(codes.NotFound, "election not found")
		}
		return nil, mapStoreError(err, "count ballots")
	}
	return &pb.CountBallotsResponse{TotalBallots: count}, nil
}

// GetElectionStatus returns OPEN, CLOSED or NOT_FOUND without ballot data.
func (s *AdminService) GetElectionStatus(ctx context.Context, request *pb.GetElectionStatusRequest) (*pb.ElectionStatusResponse, error) {
	if request == nil || !validText(request.GetElectionId(), 128) {
		return nil, status.Error(codes.InvalidArgument, "invalid election identifier")
	}
	electionStatus, err := s.store.Status(ctx, request.GetElectionId(), s.now().UTC())
	if err != nil {
		return nil, mapStoreError(err, "get election status")
	}
	return &pb.ElectionStatusResponse{Status: electionStatus}, nil
}

// NewGRPCServer registers the admin API and standard gRPC health service.
// This first prototype intentionally serves plaintext; the listener must remain internal.
func NewGRPCServer(admin *AdminService) *grpc.Server {
	server := grpc.NewServer(
		grpc.MaxRecvMsgSize(MaxMessageSize),
		grpc.MaxSendMsgSize(MaxMessageSize),
		grpc.UnaryInterceptor(deadlineInterceptor(requestTimeout)),
	)
	pb.RegisterBallotAdminServiceServer(server, admin)
	healthServer := health.NewServer()
	healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	healthServer.SetServingStatus("votaciones.ballot.v1.BallotAdminService", grpc_health_v1.HealthCheckResponse_SERVING)
	grpc_health_v1.RegisterHealthServer(server, healthServer)
	return server
}

// StopGracefully drains active requests and force-stops after timeout.
func StopGracefully(server *grpc.Server, timeout time.Duration) {
	if timeout <= 0 {
		timeout = requestTimeout
	}
	stopped := make(chan struct{})
	go func() {
		server.GracefulStop()
		close(stopped)
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-stopped:
	case <-timer.C:
		server.Stop()
		<-stopped
	}
}

func deadlineInterceptor(timeout time.Duration) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, request any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		return handler(ctx, request)
	}
}

func mapStoreError(err error, operation string) error {
	if errors.Is(err, context.Canceled) {
		return status.Error(codes.Canceled, "request canceled")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return status.Error(codes.DeadlineExceeded, "request deadline exceeded")
	}
	return status.Errorf(codes.Internal, "%s failed", operation)
}

func electionFromRequest(request *pb.RegisterElectionRequest) (election.Election, error) {
	if request == nil || !validText(request.GetElectionId(), 128) ||
		len(request.GetOptions()) == 0 || len(request.GetOptions()) > maxOptions ||
		len(request.GetEncryptionPublicKey()) == 0 || len(request.GetEncryptionPublicKey()) > 64*1024 ||
		bytesContainPrivateKey(request.GetEncryptionPublicKey()) ||
		len(request.GetTokenVerificationKeys()) == 0 || len(request.GetTokenVerificationKeys()) > maxTokenKeys ||
		request.GetOpensAtUnixSeconds() <= 0 || request.GetClosesAtUnixSeconds() <= request.GetOpensAtUnixSeconds() ||
		len(request.GetSignedParameters()) == 0 || len(request.GetSignedParameters()) > 64*1024 ||
		!validText(request.GetParameterSigningKeyId(), 64) || !validText(request.GetParameterSignatureAlgorithm(), 64) ||
		len(request.GetParameterSignature()) == 0 || len(request.GetParameterSignature()) > 16*1024 {
		return election.Election{}, election.ErrInvalidElection
	}

	options := append([]string(nil), request.GetOptions()...)
	seenOptions := make(map[string]struct{}, len(options))
	for _, option := range options {
		if !validText(option, 128) {
			return election.Election{}, election.ErrInvalidElection
		}
		if _, exists := seenOptions[option]; exists {
			return election.Election{}, election.ErrInvalidElection
		}
		seenOptions[option] = struct{}{}
	}

	keys := make([]election.TokenKey, 0, len(request.GetTokenVerificationKeys()))
	seenKIDs := make(map[string]struct{}, len(request.GetTokenVerificationKeys()))
	for _, key := range request.GetTokenVerificationKeys() {
		if key == nil || !validText(key.GetKid(), 64) {
			return election.Election{}, election.ErrInvalidElection
		}
		if _, exists := seenKIDs[key.GetKid()]; exists {
			return election.Election{}, election.ErrInvalidElection
		}
		seenKIDs[key.GetKid()] = struct{}{}
		parsedKey, err := tokenKeyFromRequest(key)
		if err != nil {
			return election.Election{}, election.ErrInvalidElection
		}
		keys = append(keys, parsedKey)
	}

	return election.Election{
		ID:                  request.GetElectionId(),
		Options:             options,
		EncryptionPublicKey: append([]byte(nil), request.GetEncryptionPublicKey()...),
		TokenKeys:           keys,
		OpensAt:             time.Unix(request.GetOpensAtUnixSeconds(), 0).UTC(),
		ClosesAt:            time.Unix(request.GetClosesAtUnixSeconds(), 0).UTC(),
		SignedParameters:    append([]byte(nil), request.GetSignedParameters()...),
		SigningKeyID:        request.GetParameterSigningKeyId(),
		SignatureAlgorithm:  request.GetParameterSignatureAlgorithm(),
		ParameterSignature:  append([]byte(nil), request.GetParameterSignature()...),
	}, nil
}

func tokenKeyFromRequest(key *pb.TokenVerificationKey) (election.TokenKey, error) {
	if key == nil || !validText(key.GetKid(), 64) || len(key.GetPublicKeyDer()) == 0 || len(key.GetPublicKeyDer()) > 16*1024 ||
		(key.GetSignatureVariant() != token.RSABSSASHA384PSSRandomized && key.GetSignatureVariant() != token.RSABSSASHA384PSSZeroRandomized) {
		return election.TokenKey{}, election.ErrInvalidElection
	}
	parsed, err := x509.ParsePKIXPublicKey(key.GetPublicKeyDer())
	if err != nil {
		return election.TokenKey{}, election.ErrInvalidElection
	}
	publicKey, ok := parsed.(*rsa.PublicKey)
	if !ok || publicKey.N == nil || publicKey.N.BitLen() < 2048 || publicKey.E < 3 || publicKey.E%2 == 0 {
		return election.TokenKey{}, election.ErrInvalidElection
	}
	return election.TokenKey{
		KID:              key.GetKid(),
		PublicKeyDER:     append([]byte(nil), key.GetPublicKeyDer()...),
		SignatureVariant: key.GetSignatureVariant(),
	}, nil
}

func validText(value string, maxBytes int) bool {
	if len(value) == 0 || len(value) > maxBytes || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func bytesContainPrivateKey(value []byte) bool {
	return strings.Contains(string(value), "PRIVATE KEY")
}
