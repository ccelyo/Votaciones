// Package httpapi exposes ballot's public, anonymous HTTP voting API.
//
// Requests carry no session: the handler never sets cookies, never reads
// identity headers and never logs request bodies, tokens or client addresses.
package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	ballotflow "github.com/ccelyo/Votaciones/ballot/internal/ballot"
	"github.com/ccelyo/Votaciones/ballot/internal/election"
	"github.com/ccelyo/Votaciones/ballot/internal/pb"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
)

const (
	// maxBallotBodyBytes covers base64url of a 1 MiB ciphertext, a 256 KiB proof and the token.
	maxBallotBodyBytes = 2 << 20
	requestTimeout     = 10 * time.Second
)

// BallotAcceptor is the validation and commit pipeline behind POST /v1/ballots.
type BallotAcceptor interface {
	Accept(ctx context.Context, electionID string, encodedToken, encryptedVote, proof []byte) (token.SignedReceipt, token.SpendResult, error)
}

// ElectionReader exposes public election parameters and lifecycle status.
type ElectionReader interface {
	Parameters(ctx context.Context, electionID string) (election.Election, error)
	Status(ctx context.Context, electionID string, now time.Time) (pb.ElectionStatus, error)
}

// ReadinessChecker reports whether backing storage is reachable.
type ReadinessChecker func(ctx context.Context) error

// Config wires the HTTP API dependencies.
type Config struct {
	Acceptor       BallotAcceptor
	Elections      ElectionReader
	Votes          ballotflow.VoteReader
	Ready          ReadinessChecker
	AllowedOrigins []string
	Logger         *slog.Logger
	Now            func() time.Time
}

type api struct {
	Config
}

// NewHandler returns the routed handler with CORS and security headers.
func NewHandler(config Config) http.Handler {
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.Logger == nil {
		config.Logger = slog.New(slog.DiscardHandler)
	}
	a := &api{Config: config}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/ballots", a.submitBallot)
	mux.HandleFunc("GET /v1/elections/{electionID}/parameters", a.electionParameters)
	mux.HandleFunc("GET /v1/elections/{electionID}/results", a.electionResults)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", a.readiness)
	return a.middleware(mux)
}

// SubmitBallotRequest is the anonymous ballot submission. Binary fields are
// unpadded base64url; token is the exact envelope returned to the browser.
type SubmitBallotRequest struct {
	ElectionID    string `json:"election_id"`
	Token         string `json:"token"`
	EncryptedVote string `json:"encrypted_vote"`
	Proof         string `json:"proof"`
}

// SubmitBallotResponse carries the signed receipt the voter keeps.
type SubmitBallotResponse struct {
	ElectionID string `json:"election_id"`
	BallotHash string `json:"ballot_hash"`
	Receipt    string `json:"receipt"`
	Replayed   bool   `json:"replayed"`
}

func (a *api) submitBallot(w http.ResponseWriter, r *http.Request) {
	if mediaType, _, _ := strings.Cut(r.Header.Get("Content-Type"), ";"); strings.TrimSpace(mediaType) != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBallotBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request SubmitBallotRequest
	if err := decoder.Decode(&request); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "request_too_large")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	encryptedVote, errVote := decodeBase64URL(request.EncryptedVote)
	proof, errProof := decodeBase64URL(request.Proof)
	if request.ElectionID == "" || request.Token == "" || errVote != nil || errProof != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}

	receipt, result, err := a.Acceptor.Accept(r.Context(), request.ElectionID, []byte(request.Token), encryptedVote, proof)
	if err != nil {
		status, code := ballotErrorStatus(err)
		if status == http.StatusInternalServerError {
			// Only the error class is logged; no ballot, token or client data.
			a.Logger.Error("ballot acceptance failed", "error", err.Error())
		}
		writeError(w, status, code)
		return
	}
	encodedReceipt, err := token.MarshalReceipt(receipt)
	if err != nil {
		a.Logger.Error("receipt encoding failed", "error", err.Error())
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	status := http.StatusCreated
	if result == token.SpendReplay {
		status = http.StatusOK
	}
	writeJSON(w, status, SubmitBallotResponse{
		ElectionID: receipt.ElectionID,
		BallotHash: base64.RawURLEncoding.EncodeToString(receipt.BallotHash),
		Receipt:    string(encodedReceipt),
		Replayed:   result == token.SpendReplay,
	})
}

// TokenKeyResponse is an identity verification key the browser blinds against.
type TokenKeyResponse struct {
	KID              string `json:"kid"`
	PublicKeyDER     string `json:"public_key_der"`
	SignatureVariant string `json:"signature_variant"`
}

// ElectionParametersResponse is everything a browser needs to build a ballot.
type ElectionParametersResponse struct {
	ElectionID                  string             `json:"election_id"`
	Status                      string             `json:"status"`
	Options                     []string           `json:"options"`
	EncryptionPublicKey         string             `json:"encryption_public_key"`
	TokenKeys                   []TokenKeyResponse `json:"token_keys"`
	OpensAt                     time.Time          `json:"opens_at"`
	ClosesAt                    time.Time          `json:"closes_at"`
	SignedParameters            string             `json:"signed_parameters"`
	ParameterSigningKeyID       string             `json:"parameter_signing_key_id"`
	ParameterSignatureAlgorithm string             `json:"parameter_signature_algorithm"`
	ParameterSignature          string             `json:"parameter_signature"`
}

func (a *api) electionParameters(w http.ResponseWriter, r *http.Request) {
	electionID := r.PathValue("electionID")
	config, err := a.Elections.Parameters(r.Context(), electionID)
	if errors.Is(err, election.ErrElectionNotFound) {
		writeError(w, http.StatusNotFound, "election_not_found")
		return
	}
	if err != nil {
		a.Logger.Error("read election parameters failed", "error", err.Error())
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	electionStatus, err := a.Elections.Status(r.Context(), electionID, a.Now().UTC())
	if err != nil {
		a.Logger.Error("read election status failed", "error", err.Error())
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	keys := make([]TokenKeyResponse, 0, len(config.TokenKeys))
	for _, key := range config.TokenKeys {
		keys = append(keys, TokenKeyResponse{
			KID:              key.KID,
			PublicKeyDER:     base64.RawURLEncoding.EncodeToString(key.PublicKeyDER),
			SignatureVariant: key.SignatureVariant,
		})
	}
	w.Header().Set("Cache-Control", "public, max-age=30")
	writeJSON(w, http.StatusOK, ElectionParametersResponse{
		ElectionID:                  config.ID,
		Status:                      statusName(electionStatus),
		Options:                     config.Options,
		EncryptionPublicKey:         base64.RawURLEncoding.EncodeToString(config.EncryptionPublicKey),
		TokenKeys:                   keys,
		OpensAt:                     config.OpensAt.UTC(),
		ClosesAt:                    config.ClosesAt.UTC(),
		SignedParameters:            base64.RawURLEncoding.EncodeToString(config.SignedParameters),
		ParameterSigningKeyID:       config.SigningKeyID,
		ParameterSignatureAlgorithm: config.SignatureAlgorithm,
		ParameterSignature:          base64.RawURLEncoding.EncodeToString(config.ParameterSignature),
	})
}

// OptionResultResponse is the number of ballots cast for one option.
type OptionResultResponse struct {
	Option string `json:"option"`
	Votes  uint64 `json:"votes"`
}

// ElectionResultsResponse is the final, aggregate count of a closed election.
type ElectionResultsResponse struct {
	ElectionID     string                 `json:"election_id"`
	TotalBallots   uint64                 `json:"total_ballots"`
	InvalidBallots uint64                 `json:"invalid_ballots"`
	Results        []OptionResultResponse `json:"results"`
}

// electionResults publishes the tally only once the election is closed, so no
// partial results can influence voters while the ballot box is open.
func (a *api) electionResults(w http.ResponseWriter, r *http.Request) {
	if a.Votes == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	electionID := r.PathValue("electionID")
	config, err := a.Elections.Parameters(r.Context(), electionID)
	if errors.Is(err, election.ErrElectionNotFound) {
		writeError(w, http.StatusNotFound, "election_not_found")
		return
	}
	if err != nil {
		a.Logger.Error("read election parameters failed", "error", err.Error())
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	electionStatus, err := a.Elections.Status(r.Context(), electionID, a.Now().UTC())
	if err != nil {
		a.Logger.Error("read election status failed", "error", err.Error())
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if electionStatus != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
		writeError(w, http.StatusConflict, "election_not_closed")
		return
	}
	votes, err := a.Votes.Votes(r.Context(), electionID)
	if err != nil {
		a.Logger.Error("read votes failed", "error", err.Error())
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	tally := ballotflow.CountVotes(config.Options, votes)
	results := make([]OptionResultResponse, len(tally.Options))
	for i, count := range tally.Options {
		results[i] = OptionResultResponse{Option: count.Option, Votes: count.Votes}
	}
	writeJSON(w, http.StatusOK, ElectionResultsResponse{
		ElectionID:     config.ID,
		TotalBallots:   tally.Total,
		InvalidBallots: tally.Invalid,
		Results:        results,
	})
}

func (a *api) readiness(w http.ResponseWriter, r *http.Request) {
	if a.Ready != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := a.Ready(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, "not_ready")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

// middleware applies the request deadline, security headers and CORS. CORS
// never allows credentials, so browsers cannot attach cookies to ballots.
func (a *api) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("Cache-Control", "no-store")
		header.Set("Referrer-Policy", "no-referrer")
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")

		if origin := r.Header.Get("Origin"); origin != "" && a.originAllowed(origin) {
			header.Set("Access-Control-Allow-Origin", origin)
			header.Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				header.Set("Access-Control-Allow-Methods", "GET, POST")
				header.Set("Access-Control-Allow-Headers", "Content-Type")
				header.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		} else if r.Method == http.MethodOptions {
			writeError(w, http.StatusForbidden, "origin_not_allowed")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (a *api) originAllowed(origin string) bool {
	return slices.Contains(a.AllowedOrigins, "*") || slices.Contains(a.AllowedOrigins, origin)
}

func ballotErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, token.ErrAlreadySpent):
		return http.StatusConflict, "token_already_spent"
	case errors.Is(err, token.ErrElectionClosed):
		return http.StatusConflict, "election_not_open"
	case errors.Is(err, token.ErrWrongElection):
		return http.StatusForbidden, "token_election_mismatch"
	case errors.Is(err, token.ErrInvalidSignature):
		return http.StatusForbidden, "invalid_token_signature"
	case errors.Is(err, token.ErrInvalidToken):
		return http.StatusBadRequest, "invalid_token"
	case errors.Is(err, ballotflow.ErrInvalidProof):
		return http.StatusUnprocessableEntity, "invalid_proof"
	case errors.Is(err, ballotflow.ErrInvalidBallot), errors.Is(err, ballotflow.ErrInvalidBallotHash):
		return http.StatusBadRequest, "invalid_ballot"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return http.StatusServiceUnavailable, "timeout"
	default:
		return http.StatusInternalServerError, "internal_error"
	}
}

func statusName(status pb.ElectionStatus) string {
	switch status {
	case pb.ElectionStatus_ELECTION_STATUS_OPEN:
		return "open"
	case pb.ElectionStatus_ELECTION_STATUS_CLOSED:
		return "closed"
	default:
		return "unknown"
	}
}

func decodeBase64URL(value string) ([]byte, error) {
	if value == "" {
		return nil, errors.New("empty value")
	}
	return base64.RawURLEncoding.Strict().DecodeString(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
