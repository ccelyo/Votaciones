package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	ballotflow "github.com/ccelyo/Votaciones/ballot/internal/ballot"
	"github.com/ccelyo/Votaciones/ballot/internal/election"
	"github.com/ccelyo/Votaciones/ballot/internal/server"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"google.golang.org/grpc"
)

const defaultGRPCAddress = "127.0.0.1:9091"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("ballot service stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	if _, err := token.LoadReceiptPrivateKey(); err != nil {
		return errors.New("receipt signing key configuration is missing or invalid")
	}
	address := strings.TrimSpace(os.Getenv("BALLOT_GRPC_ADDR"))
	if address == "" {
		address = defaultGRPCAddress
	}
	if _, _, err := net.SplitHostPort(address); err != nil {
		return errors.New("BALLOT_GRPC_ADDR must be a host:port address")
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}

	store := election.NewMemoryStore()
	ballots := ballotflow.NewMemoryCommitStore()
	grpcServer := server.NewGRPCServer(server.NewAdminService(store, nil, ballots))
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- grpcServer.Serve(listener) }()
	logger.Info("ballot internal gRPC listener started", "address", listener.Addr().String())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-serveErrors:
		if err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			return err
		}
		return nil
	case <-ctx.Done():
		logger.Info("ballot internal gRPC listener shutting down")
		server.StopGracefully(grpcServer, 10*time.Second)
		return nil
	}
}
