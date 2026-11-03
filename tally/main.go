// Tally reads a closed urn from Ballot over REST, decrypts and counts it, and
// publishes tally.completed to RabbitMQ. It has no database of its own.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ccelyo/Votaciones/tally/internal/ballotclient"
	"github.com/ccelyo/Votaciones/tally/internal/config"
	"github.com/ccelyo/Votaciones/tally/internal/decrypt"
	"github.com/ccelyo/Votaciones/tally/internal/httpapi"
	"github.com/ccelyo/Votaciones/tally/internal/publisher"
	"github.com/ccelyo/Votaciones/tally/internal/tally"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		if err := healthcheck(); err != nil {
			os.Exit(1)
		}
		return
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("tally service stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	defaultDecryptor, err := decrypt.New(cfg.PrivateKey, cfg.AllowPlaintext)
	if err != nil {
		return err
	}
	if !defaultDecryptor.HasKey() {
		if cfg.AllowPlaintext {
			logger.Warn("no default urn private key; plaintext ballots are accepted and encrypted ballots need a key in the launch request")
		} else {
			logger.Warn("no default urn private key; every scrutiny must supply the key in the launch request")
		}
	}

	ballotClient := ballotclient.New(cfg.BallotURL, cfg.BallotToken, cfg.HTTPTimeout)
	broker := publisher.NewRabbit(cfg.RabbitMQURI, cfg.Exchange, cfg.PublishAttempts)
	defer func() { _ = broker.Close() }()

	service := tally.New(ballotClient, broker, defaultDecryptor, cfg.AllowPlaintext, logger)
	handler := httpapi.NewHandler(httpapi.Config{
		Service: service,
		Logger:  logger,
		Ready: func(ctx context.Context) error {
			if err := ballotClient.Health(ctx); err != nil {
				return err
			}
			return broker.Ping(ctx)
		},
	})

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      75 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.ListenAndServe() }()
	logger.Info("tally service started",
		"http_address", cfg.HTTPAddr,
		"ballot_url", cfg.BallotURL,
		"rabbitmq_exchange", cfg.Exchange,
		"allow_plaintext", cfg.AllowPlaintext,
	)

	var serveErr error
	select {
	case err := <-serveErrors:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr = err
		}
	case <-ctx.Done():
		logger.Info("tally service shutting down")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	return serveErr
}

// healthcheck backs the Docker HEALTHCHECK without adding curl/wget to the
// distroless image. It only checks liveness, not Ballot or RabbitMQ.
func healthcheck() error {
	target := os.Getenv("TALLY_HEALTHCHECK_URL")
	if target == "" {
		target = "http://127.0.0.1:8092/healthz"
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(target)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("health endpoint is not ready")
	}
	return nil
}
