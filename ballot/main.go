package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	ballotflow "github.com/ccelyo/Votaciones/ballot/internal/ballot"
	"github.com/ccelyo/Votaciones/ballot/internal/election"
	"github.com/ccelyo/Votaciones/ballot/internal/events"
	"github.com/ccelyo/Votaciones/ballot/internal/httpapi"
	"github.com/ccelyo/Votaciones/ballot/internal/mongostore"
	"github.com/ccelyo/Votaciones/ballot/internal/server"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

const (
	defaultGRPCAddress = "127.0.0.1:9091"
	defaultHTTPAddress = ":8080"
	defaultMongoDB     = "votaciones"
)

// commitStore is satisfied by both the Mongo adapter and the in-memory fake.
type commitStore interface {
	ballotflow.CommitStore
	ballotflow.VoteReader
	ballotflow.SealedBallotReader
	election.ParticipationCounter
}

// electionBackend is satisfied by both the Mongo adapter and election.MemoryStore.
type electionBackend interface {
	election.Store
	token.KeyResolver
	token.ElectionStateReader
	ballotflow.ElectionCommitGate
	httpapi.ElectionReader
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("ballot service stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	receiptKey, err := token.LoadReceiptPrivateKey()
	if err != nil {
		return errors.New("receipt signing key configuration is missing or invalid")
	}
	grpcAddress := envOr("BALLOT_GRPC_ADDR", defaultGRPCAddress)
	if _, _, err := net.SplitHostPort(grpcAddress); err != nil {
		return errors.New("BALLOT_GRPC_ADDR must be a host:port address")
	}
	httpAddress := httpListenAddress()
	if _, _, err := net.SplitHostPort(httpAddress); err != nil {
		return errors.New("BALLOT_HTTP_ADDR must be a host:port address")
	}
	httpTLS, err := server.MutualTLSConfig(
		strings.TrimSpace(os.Getenv("BALLOT_HTTP_TLS_CERT_FILE")),
		strings.TrimSpace(os.Getenv("BALLOT_HTTP_TLS_KEY_FILE")),
		strings.TrimSpace(os.Getenv("BALLOT_HTTP_TLS_CLIENT_CA_FILE")),
		"gateway", "tally",
	)
	if err != nil {
		return err
	}
	grpcTLS, err := server.MutualTLSConfig(
		strings.TrimSpace(os.Getenv("BALLOT_GRPC_TLS_CERT_FILE")),
		strings.TrimSpace(os.Getenv("BALLOT_GRPC_TLS_KEY_FILE")),
		strings.TrimSpace(os.Getenv("BALLOT_GRPC_TLS_CLIENT_CA_FILE")),
		"identity",
	)
	if err != nil {
		return err
	}
	tlsRequired := strings.EqualFold(strings.TrimSpace(os.Getenv("BALLOT_TLS_REQUIRED")), "true")
	if tlsRequired && (httpTLS == nil || grpcTLS == nil) {
		return errors.New("BALLOT_TLS_REQUIRED needs mTLS configured for both HTTP and gRPC")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var elections electionBackend
	var ballots commitStore
	var ready httpapi.ReadinessChecker
	if uri := strings.TrimSpace(os.Getenv("MONGODB_URI")); uri != "" {
		connectCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		mongo, err := mongostore.Connect(connectCtx, uri, envOr("MONGODB_DATABASE", defaultMongoDB))
		if err == nil {
			err = mongo.EnsureIndexes(connectCtx)
		}
		cancel()
		if err != nil {
			return err
		}
		defer func() {
			disconnectCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = mongo.Disconnect(disconnectCtx)
		}()
		elections, ballots, ready = mongo, mongo, mongo.Ping
		logger.Info("ballot store connected", "backend", "mongodb")
	} else {
		elections, ballots = election.NewMemoryStore(), ballotflow.NewMemoryCommitStore()
		logger.Warn("MONGODB_URI is not set; elections and ballots are kept in memory and lost on restart")
	}

	acceptor := ballotflow.NewAcceptor(
		token.NewVerifier(elections, elections),
		ballotflow.StructuralProofVerifier{},
		ballots,
		elections,
		receiptKey,
	)
	var publisher httpapi.VotePublisher
	if uri := strings.TrimSpace(os.Getenv("BALLOT_RABBITMQ_URI")); uri != "" {
		connected, err := dialPublisher(ctx, uri)
		if err != nil {
			return err
		}
		defer connected.Close()
		publisher = connected
		logger.Info("votes.cast publisher connected", "exchange", events.VotesExchange)
		go consumeElections(ctx, uri, elections, logger)
	} else {
		logger.Warn("BALLOT_RABBITMQ_URI is not set; accepted ballots will not publish votes.cast or consume election.events")
	}
	var grpcOptions []grpc.ServerOption
	if grpcTLS != nil {
		grpcOptions = append(grpcOptions, grpc.Creds(credentials.NewTLS(grpcTLS)))
	}
	grpcServer := server.NewGRPCServer(server.NewAdminService(elections, nil, ballots), grpcOptions...)
	var handler http.Handler = httpapi.NewHandler(httpapi.Config{
		Acceptor:       acceptor,
		Elections:      elections,
		Votes:          ballots,
		Sealed:         ballots,
		Publisher:      publisher,
		Ready:          ready,
		AllowedOrigins: splitList(os.Getenv("BALLOT_ALLOWED_ORIGINS")),
		TallyToken:     strings.TrimSpace(os.Getenv("BALLOT_TALLY_TOKEN")),
		Logger:         logger,
	})
	grpcOnHTTP := strings.EqualFold(strings.TrimSpace(os.Getenv("BALLOT_SERVE_GRPC_ON_HTTP")), "true")
	if grpcOnHTTP && grpcTLS != nil {
		return errors.New("BALLOT_SERVE_GRPC_ON_HTTP cannot be used with the separate mTLS gRPC listener")
	}
	var protocols *http.Protocols
	if grpcOnHTTP {
		handler = grpcOrHTTP(grpcServer, handler)
		protocols = new(http.Protocols)
		protocols.SetHTTP1(true)
		protocols.SetUnencryptedHTTP2(true)
	}
	httpServer := &http.Server{
		Addr:              httpAddress,
		Handler:           handler,
		TLSConfig:         httpTLS,
		Protocols:         protocols,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	serveErrors := make(chan error, 2)
	if grpcOnHTTP {
		logger.Info("ballot service started", "grpc_address", httpAddress, "http_address", httpAddress)
	} else {
		grpcListener, err := net.Listen("tcp", grpcAddress)
		if err != nil {
			return err
		}
		go func() { serveErrors <- grpcServer.Serve(grpcListener) }()
		logger.Info("ballot service started", "grpc_address", grpcListener.Addr().String(), "http_address", httpAddress)
	}
	if httpTLS != nil {
		go func() { serveErrors <- httpServer.ListenAndServeTLS("", "") }()
	} else {
		go func() { serveErrors <- httpServer.ListenAndServe() }()
	}

	var serveErr error
	select {
	case err := <-serveErrors:
		if err != nil && !errors.Is(err, grpc.ErrServerStopped) && !errors.Is(err, http.ErrServerClosed) {
			serveErr = err
		}
	case <-ctx.Done():
		logger.Info("ballot service shutting down")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	server.StopGracefully(grpcServer, 10*time.Second)
	return serveErr
}

// grpcOrHTTP routes gRPC requests (HTTP/2 with a gRPC content type) to the
// admin gRPC server and everything else to the public HTTP API.
func grpcOrHTTP(grpcServer *grpc.Server, httpHandler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor == 2 && strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc") {
			grpcServer.ServeHTTP(w, r)
			return
		}
		httpHandler.ServeHTTP(w, r)
	})
}

// httpListenAddress honors Cloud Run's PORT before BALLOT_HTTP_ADDR.
func httpListenAddress() string {
	if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
		return ":" + port
	}
	return envOr("BALLOT_HTTP_ADDR", defaultHTTPAddress)
}

func consumeElections(ctx context.Context, uri string, store election.Store, logger *slog.Logger) {
	for {
		if ctx.Err() != nil {
			return
		}
		consumer, err := events.DialElectionConsumer(uri)
		if err != nil {
			logger.Error("election consumer dial failed", "error", err)
			if !wait(ctx, 5*time.Second) {
				return
			}
			continue
		}
		logger.Info("election consumer connected", "queue", events.ElectionQueue)
		err = consumer.Run(ctx, func(ctx context.Context, body []byte) error {
			applyErr := events.ApplyElectionEvent(ctx, store, body)
			if applyErr == nil {
				return nil
			}
			if errors.Is(applyErr, events.ErrMetadataOnly) || errors.Is(applyErr, events.ErrElectionNotRegistered) || errors.Is(applyErr, events.ErrPermanentEvent) {
				logger.Warn("election event ignored", "error", applyErr.Error())
				return nil
			}
			logger.Error("election event was not applied", "error", applyErr.Error())
			return applyErr
		})
		_ = consumer.Close()
		if ctx.Err() != nil {
			return
		}
		logger.Error("election consumer stopped", "error", err)
		if !wait(ctx, 5*time.Second) {
			return
		}
	}
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func dialPublisher(ctx context.Context, uri string) (*events.Publisher, error) {
	var last error
	for attempt := 0; attempt < 12; attempt++ {
		publisher, err := events.Dial(uri)
		if err == nil {
			return publisher, nil
		}
		last = err
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, last
		case <-timer.C:
		}
	}
	return nil, last
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func splitList(value string) []string {
	var items []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}
