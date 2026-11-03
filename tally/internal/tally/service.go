// Package tally orchestrates one scrutiny: read the closed urn from Ballot,
// decrypt and count it, and publish tally.completed exactly once per content.
package tally

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/ccelyo/Votaciones/tally/internal/ballotclient"
	"github.com/ccelyo/Votaciones/tally/internal/count"
	"github.com/ccelyo/Votaciones/tally/internal/decrypt"
	"github.com/ccelyo/Votaciones/tally/internal/events"
	"github.com/ccelyo/Votaciones/tally/internal/publisher"
)

var (
	// ErrTallyPending means no scrutiny has completed in this process yet.
	ErrTallyPending = errors.New("tally pending")
	// ErrWrongPrivateKey means the supplied key does not belong to the urn.
	ErrWrongPrivateKey = errors.New("urn private key does not match the election")
)

// BallotAPI is the read port to Ballot.
type BallotAPI interface {
	Parameters(ctx context.Context, electionID string) (ballotclient.Parameters, error)
	Ballots(ctx context.Context, electionID string) ([][]byte, error)
}

// Completed is the official count returned by the HTTP API.
type Completed struct {
	ElectionID     string              `json:"election_id"`
	TotalBallots   uint64              `json:"total_ballots"`
	InvalidBallots uint64              `json:"invalid_ballots"`
	Results        []count.OptionCount `json:"results"`
	TalliedAt      time.Time           `json:"tallied_at"`
	EventID        string              `json:"event_id"`
	Reused         bool                `json:"reused"`
}

// RunRequest carries the optional per-launch urn key and republish flag.
type RunRequest struct {
	PrivateKey []byte
	Republish  bool
}

// Service is stateless between restarts by design: the only state is an
// in-memory cache of the last result. Analytics persists the official event,
// and the deterministic event_id makes a recomputation idempotent.
type Service struct {
	ballots    BallotAPI
	broker     publisher.Publisher
	defaultKey *decrypt.Decryptor
	allowPlain bool
	logger     *slog.Logger
	now        func() time.Time
	mu         sync.RWMutex
	cache      map[string]cachedResult
	flights    flightGroup
}

type cachedResult struct {
	digest    string
	envelope  events.Envelope
	completed Completed
}

// New wires the service.
func New(ballots BallotAPI, broker publisher.Publisher, defaultKey *decrypt.Decryptor, allowPlaintext bool, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Service{
		ballots:    ballots,
		broker:     broker,
		defaultKey: defaultKey,
		allowPlain: allowPlaintext,
		logger:     logger,
		now:        time.Now,
		cache:      make(map[string]cachedResult),
	}
}

// SetClock overrides the tally clock; intended for tests.
func (s *Service) SetClock(now func() time.Time) {
	if now != nil {
		s.now = now
	}
}

// Run counts one election. Calling it again over the same closed urn returns
// the cached result without publishing a second event; the event_id is also
// stable across restarts, so Analytics de-duplicates any recomputation.
func (s *Service) Run(ctx context.Context, electionID string, request RunRequest) (Completed, error) {
	params, err := s.ballots.Parameters(ctx, electionID)
	if err != nil {
		return Completed{}, err
	}
	if err := count.ValidateOptions(params.Options); err != nil {
		return Completed{}, err
	}
	ballots, err := s.ballots.Ballots(ctx, electionID)
	if err != nil {
		return Completed{}, err
	}
	digest := count.Digest(electionID, params.Options, ballots)

	if cached, ok := s.lookup(electionID, digest); ok && !request.Republish {
		cached.completed.Reused = true
		s.logger.Info("scrutiny already completed; reusing result",
			"election_id", electionID, "event_id", cached.envelope.EventID, "ballots", cached.completed.TotalBallots)
		return cached.completed, nil
	}

	key := electionID + "|" + digest
	return s.flights.Do(key, func() (Completed, error) {
		// A concurrent request may have finished while this one waited.
		if cached, ok := s.lookup(electionID, digest); ok {
			if !request.Republish {
				cached.completed.Reused = true
				return cached.completed, nil
			}
			if err := s.broker.Publish(ctx, cached.envelope); err != nil {
				return Completed{}, err
			}
			cached.completed.Reused = true
			return cached.completed, nil
		}
		result, hasKey, err := s.countAndVerify(electionID, params, ballots, request.PrivateKey)
		if err != nil {
			return Completed{}, err
		}
		envelope := events.NewCompleted(
			electionID,
			digest,
			result.TotalBallots,
			result.InvalidBallots,
			optionVotes(result.Results),
			s.now().UTC(),
		)
		if err := s.broker.Publish(ctx, envelope); err != nil {
			return Completed{}, err
		}
		completed := Completed{
			ElectionID:     result.ElectionID,
			TotalBallots:   result.TotalBallots,
			InvalidBallots: result.InvalidBallots,
			Results:        result.Results,
			TalliedAt:      envelope.Data.TalliedAt,
			EventID:        envelope.EventID,
		}
		s.store(electionID, cachedResult{digest: digest, envelope: envelope, completed: completed})
		s.logger.Info("scrutiny completed",
			"election_id", electionID,
			"event_id", envelope.EventID,
			"ballots", result.TotalBallots,
			"invalid", result.InvalidBallots,
			"has_urn_key", hasKey,
			"ballots_digest", digest,
		)
		return completed, nil
	})
}

// Get returns the last result computed by this process.
func (s *Service) Get(electionID string) (Completed, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cached, ok := s.cache[electionID]
	if !ok {
		return Completed{}, ErrTallyPending
	}
	return cached.completed, nil
}

func (s *Service) countAndVerify(electionID string, params ballotclient.Parameters, ballots [][]byte, privateKey []byte) (count.Result, bool, error) {
	decryptor := s.defaultKey
	if len(privateKey) > 0 {
		built, err := decrypt.New(privateKey, s.allowPlain)
		if err != nil {
			return count.Result{}, false, err
		}
		decryptor = built
	}
	if decryptor == nil {
		decryptor, _ = decrypt.New(nil, s.allowPlain)
	}

	if publicKey, err := params.PublicKeyDER(); err == nil && len(publicKey) > 0 {
		match, comparable := decryptor.MatchesPublicKey(publicKey)
		switch {
		case comparable && !match:
			return count.Result{}, false, ErrWrongPrivateKey
		case !comparable:
			s.logger.Warn("election encryption_public_key is not a parseable RSA key; skipping key check",
				"election_id", electionID)
		}
	}
	result, err := count.Count(electionID, params.Options, ballots, decryptor.Decrypt)
	if err != nil {
		return count.Result{}, false, err
	}
	return result, decryptor.HasKey(), nil
}

func (s *Service) lookup(electionID, digest string) (cachedResult, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cached, ok := s.cache[electionID]
	if !ok || cached.digest != digest {
		return cachedResult{}, false
	}
	return cached, true
}

func (s *Service) store(electionID string, value cachedResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cache[electionID] = value
}

func optionVotes(results []count.OptionCount) []events.OptionVotes {
	votes := make([]events.OptionVotes, len(results))
	for i, result := range results {
		votes[i] = events.OptionVotes{Option: result.Option, Votes: result.Votes}
	}
	return votes
}

// flightGroup coalesces concurrent scrutinies of the same election and digest.
type flightGroup struct {
	mu    sync.Mutex
	calls map[string]*flightCall
}

type flightCall struct {
	done      chan struct{}
	completed Completed
	err       error
}

func (g *flightGroup) Do(key string, fn func() (Completed, error)) (Completed, error) {
	g.mu.Lock()
	if existing, ok := g.calls[key]; ok {
		g.mu.Unlock()
		<-existing.done
		return existing.completed, existing.err
	}
	if g.calls == nil {
		g.calls = make(map[string]*flightCall)
	}
	call := &flightCall{done: make(chan struct{})}
	g.calls[key] = call
	g.mu.Unlock()

	call.completed, call.err = fn()
	close(call.done)

	g.mu.Lock()
	delete(g.calls, key)
	g.mu.Unlock()
	return call.completed, call.err
}

func (c Completed) String() string {
	return fmt.Sprintf("%s: %d ballots, %d invalid, event %s", c.ElectionID, c.TotalBallots, c.InvalidBallots, c.EventID)
}
