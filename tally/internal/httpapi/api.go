// Package httpapi exposes Tally's small internal REST API. Authentication is
// delegated to the API Gateway (admin role for POST, user role for GET); Tally
// never receives voter data.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/ccelyo/Votaciones/tally/internal/ballotclient"
	"github.com/ccelyo/Votaciones/tally/internal/count"
	"github.com/ccelyo/Votaciones/tally/internal/decrypt"
	"github.com/ccelyo/Votaciones/tally/internal/publisher"
	"github.com/ccelyo/Votaciones/tally/internal/tally"
)

const (
	maxBodyBytes    = 64 << 10
	scrutinyTimeout = 60 * time.Second
)

// Service is the use-case port implemented by *tally.Service.
type Service interface {
	Run(ctx context.Context, electionID string, request tally.RunRequest) (tally.Completed, error)
	Get(electionID string) (tally.Completed, error)
}

// ReadinessChecker reports whether Ballot and RabbitMQ are reachable.
type ReadinessChecker func(ctx context.Context) error

// Config wires the HTTP handler.
type Config struct {
	Service Service
	Ready   ReadinessChecker
	Logger  *slog.Logger
}

type api struct {
	Config
}

// NewHandler returns the routed handler.
func NewHandler(config Config) http.Handler {
	if config.Logger == nil {
		config.Logger = slog.New(slog.DiscardHandler)
	}
	a := &api{Config: config}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/tally/elections/{electionID}", a.run)
	mux.HandleFunc("GET /v1/tally/elections/{electionID}", a.get)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", a.readiness)
	return a.securityHeaders(mux)
}

// RunRequest is the optional body of POST. The private key is the urn's RSA
// key in PEM, DER or base64; when omitted, TALLY_PRIVATE_KEY(_FILE) is used.
type RunRequest struct {
	PrivateKey string `json:"private_key"`
	Republish  bool   `json:"republish"`
}

func (a *api) run(w http.ResponseWriter, r *http.Request) {
	electionID := r.PathValue("electionID")
	if !validElectionID(electionID) {
		writeError(w, http.StatusBadRequest, "invalid_election_id")
		return
	}
	request, err := decodeRunRequest(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}

	// El escrutinio es idempotente y su resultado oficial debe publicarse aunque
	// el cliente (la CLI o el Gateway) corte la conexión: se desacopla del
	// contexto de la petición y se acota con su propio timeout.
	base := context.WithoutCancel(r.Context())
	ctx, cancel := context.WithTimeout(base, scrutinyTimeout)
	defer cancel()
	completed, err := a.Service.Run(ctx, electionID, tally.RunRequest{
		PrivateKey: []byte(request.PrivateKey),
		Republish:  request.Republish,
	})
	if err != nil {
		status, code := errorStatus(err)
		if status >= http.StatusInternalServerError {
			a.Logger.Error("scrutiny failed", "election_id", electionID, "error", err.Error())
		}
		writeError(w, status, code)
		return
	}
	writeJSON(w, http.StatusOK, completed)
}

func (a *api) get(w http.ResponseWriter, r *http.Request) {
	electionID := r.PathValue("electionID")
	if !validElectionID(electionID) {
		writeError(w, http.StatusBadRequest, "invalid_election_id")
		return
	}
	completed, err := a.Service.Get(electionID)
	if err != nil {
		status, code := errorStatus(err)
		writeError(w, status, code)
		return
	}
	writeJSON(w, http.StatusOK, completed)
}

func (a *api) readiness(w http.ResponseWriter, r *http.Request) {
	if a.Ready != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := a.Ready(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, "not_ready")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (a *api) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func decodeRunRequest(w http.ResponseWriter, r *http.Request) (RunRequest, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request RunRequest
	if err := decoder.Decode(&request); err != nil {
		if errors.Is(err, io.EOF) {
			return RunRequest{}, nil
		}
		return RunRequest{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return RunRequest{}, errors.New("unexpected trailing JSON")
	}
	return request, nil
}

func errorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, ballotclient.ErrElectionNotFound):
		return http.StatusNotFound, "election_not_found"
	case errors.Is(err, tally.ErrTallyPending):
		return http.StatusNotFound, "tally_pending"
	case errors.Is(err, ballotclient.ErrElectionNotClosed):
		return http.StatusConflict, "election_not_closed"
	case errors.Is(err, count.ErrInvalidOptions):
		return http.StatusUnprocessableEntity, "invalid_election_options"
	case errors.Is(err, tally.ErrWrongPrivateKey), errors.Is(err, decrypt.ErrInvalidPrivateKey):
		return http.StatusBadRequest, "invalid_private_key"
	case errors.Is(err, decrypt.ErrPrivateKeyRequired):
		return http.StatusBadRequest, "urn_key_required"
	case errors.Is(err, count.ErrAllUndecryptable):
		return http.StatusBadRequest, "all_ballots_undecryptable"
	case errors.Is(err, ballotclient.ErrUnavailable):
		return http.StatusBadGateway, "ballot_unavailable"
	case errors.Is(err, publisher.ErrUnavailable):
		return http.StatusServiceUnavailable, "broker_unavailable"
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, "upstream_timeout"
	default:
		return http.StatusInternalServerError, "internal_error"
	}
}

func validElectionID(electionID string) bool {
	return electionID != "" && len(electionID) <= 128 && !strings.ContainsAny(electionID, "/?#")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
