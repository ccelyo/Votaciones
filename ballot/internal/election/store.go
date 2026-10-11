// Package election contains ballot's election configuration and lifecycle store.
package election

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ccelyo/Votaciones/ballot/internal/pb"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
)

var (
	ErrElectionNotFound     = errors.New("election not found")
	ErrRegistrationConflict = errors.New("election registration conflicts with existing election")
	ErrTokenKeyConflict     = errors.New("token key identifier conflicts with an existing key")
	ErrInvalidElection      = errors.New("invalid election configuration")
)

// TokenKey identifies one accepted identity signing key. Multiple keys support rotation.
type TokenKey struct {
	KID              string
	PublicKeyDER     []byte
	SignatureVariant string
}

// Election is the immutable election configuration sent by identity.
type Election struct {
	ID                  string
	Options             []string
	EncryptionPublicKey []byte
	TokenKeys           []TokenKey
	OpensAt             time.Time
	ClosesAt            time.Time
	SignedParameters    []byte
	SigningKeyID        string
	SignatureAlgorithm  string
	ParameterSignature  []byte
}

// Store is the lifecycle and participation interface consumed by the gRPC API.
type Store interface {
	Register(ctx context.Context, election Election) (created bool, err error)
	AddTokenVerificationKey(ctx context.Context, electionID string, key TokenKey) (created bool, err error)
	Close(ctx context.Context, electionID string, now time.Time) (pb.ElectionStatus, error)
	Status(ctx context.Context, electionID string, now time.Time) (pb.ElectionStatus, error)
	Count(ctx context.Context, electionID string) (uint64, error)
}

// ParticipationCounter may be backed by the same ballot repository that commits votes.
type ParticipationCounter interface {
	CountBallots(ctx context.Context, electionID string) (uint64, error)
}

type electionRecord struct {
	config Election
	closed bool
}

// MemoryStore is the local prototype implementation. The Mongo-backed production
// adapter is intentionally an M7 integration point and is not included here.
type MemoryStore struct {
	mu            sync.RWMutex
	elections     map[string]electionRecord
	participation map[string]uint64
	now           func() time.Time
}

// NewMemoryStore returns a memory-backed store using the system clock.
func NewMemoryStore() *MemoryStore {
	return NewMemoryStoreWithClock(time.Now)
}

// NewMemoryStoreWithClock allows deterministic lifecycle tests.
func NewMemoryStoreWithClock(now func() time.Time) *MemoryStore {
	if now == nil {
		now = time.Now
	}
	return &MemoryStore{
		elections:     make(map[string]electionRecord),
		participation: make(map[string]uint64),
		now:           now,
	}
}

// Register idempotently stores an election's public parameters and verification keys.
func (s *MemoryStore) Register(ctx context.Context, config Election) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if s == nil || config.ID == "" || !config.ClosesAt.After(config.OpensAt) || len(config.TokenKeys) == 0 {
		return false, ErrInvalidElection
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if existing, ok := s.elections[config.ID]; ok {
		if sameElection(existing.config, config) {
			return false, nil
		}
		return false, ErrRegistrationConflict
	}
	s.elections[config.ID] = electionRecord{config: cloneElection(config)}
	s.participation[config.ID] = 0
	return true, nil
}

// AddTokenVerificationKey adds an identity signing key without replacing old
// keys, so already-issued tokens remain verifiable during key rotation.
func (s *MemoryStore) AddTokenVerificationKey(ctx context.Context, electionID string, key TokenKey) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if s == nil || !validTokenKey(key) || electionID == "" {
		return false, ErrInvalidElection
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	record, ok := s.elections[electionID]
	if !ok {
		return false, ErrElectionNotFound
	}
	if record.closed || !s.now().UTC().Before(record.config.ClosesAt) {
		return false, token.ErrElectionClosed
	}
	for _, existing := range record.config.TokenKeys {
		if existing.KID != key.KID {
			continue
		}
		if reflect.DeepEqual(existing, key) {
			return false, nil
		}
		return false, ErrTokenKeyConflict
	}
	record.config.TokenKeys = append(record.config.TokenKeys, cloneTokenKey(key))
	sort.Slice(record.config.TokenKeys, func(i, j int) bool {
		return record.config.TokenKeys[i].KID < record.config.TokenKeys[j].KID
	})
	s.elections[electionID] = record
	return true, nil
}

// Close irreversibly closes an election. Repeated close requests are idempotent.
func (s *MemoryStore) Close(ctx context.Context, electionID string, _ time.Time) (pb.ElectionStatus, error) {
	if err := ctx.Err(); err != nil {
		return pb.ElectionStatus_ELECTION_STATUS_UNSPECIFIED, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return pb.ElectionStatus_ELECTION_STATUS_UNSPECIFIED, err
	}
	record, ok := s.elections[electionID]
	if !ok {
		return pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND, ErrElectionNotFound
	}
	record.closed = true
	s.elections[electionID] = record
	return pb.ElectionStatus_ELECTION_STATUS_CLOSED, nil
}

// CommitWhileOpen holds the lifecycle read lock while a ballot is committed.
// Close takes the write lock, so once Close returns no commit can have passed
// the open check but still be in flight.
func (s *MemoryStore) CommitWhileOpen(ctx context.Context, electionID string, commit func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil || commit == nil {
		return ErrInvalidElection
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	record, ok := s.elections[electionID]
	if !ok {
		return token.ErrWrongElection
	}
	now := s.now().UTC()
	if record.closed || now.Before(record.config.OpensAt) || !now.Before(record.config.ClosesAt) {
		return token.ErrElectionClosed
	}
	return commit()
}

// Status reports only whether an election accepts ballots, is closed, or is absent.
func (s *MemoryStore) Status(ctx context.Context, electionID string, now time.Time) (pb.ElectionStatus, error) {
	if err := ctx.Err(); err != nil {
		return pb.ElectionStatus_ELECTION_STATUS_UNSPECIFIED, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.elections[electionID]
	if !ok {
		return pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND, nil
	}
	if record.closed || !now.Before(record.config.ClosesAt) || now.Before(record.config.OpensAt) {
		return pb.ElectionStatus_ELECTION_STATUS_CLOSED, nil
	}
	return pb.ElectionStatus_ELECTION_STATUS_OPEN, nil
}

// Count returns participation only; it never reads or returns vote contents.
func (s *MemoryStore) Count(ctx context.Context, electionID string) (uint64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.elections[electionID]; !ok {
		return 0, ErrElectionNotFound
	}
	return s.participation[electionID], nil
}

// AddParticipation increments the test implementation's participation counter.
// A Mongo adapter would derive this count from committed ballot documents.
func (s *MemoryStore) AddParticipation(ctx context.Context, electionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.elections[electionID]; !ok {
		return ErrElectionNotFound
	}
	s.participation[electionID]++
	return nil
}

// ResolveTokenKey implements token.KeyResolver for registered election keys.
func (s *MemoryStore) ResolveTokenKey(ctx context.Context, electionID, kid string) (token.VerificationKey, bool, error) {
	if err := ctx.Err(); err != nil {
		return token.VerificationKey{}, false, err
	}
	s.mu.RLock()
	record, ok := s.elections[electionID]
	if !ok {
		s.mu.RUnlock()
		return token.VerificationKey{}, false, nil
	}
	var selected *TokenKey
	for i := range record.config.TokenKeys {
		if record.config.TokenKeys[i].KID == kid {
			key := record.config.TokenKeys[i]
			selected = &key
			break
		}
	}
	s.mu.RUnlock()
	if selected == nil {
		return token.VerificationKey{}, false, nil
	}
	parsed, err := x509.ParsePKIXPublicKey(selected.PublicKeyDER)
	if err != nil {
		return token.VerificationKey{}, false, err
	}
	publicKey, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return token.VerificationKey{}, false, ErrInvalidElection
	}
	return token.VerificationKey{PublicKey: publicKey, Variant: selected.SignatureVariant}, true, nil
}

// ElectionState implements token.ElectionStateReader using the store's clock.
func (s *MemoryStore) ElectionState(ctx context.Context, electionID string) (bool, bool, error) {
	if err := ctx.Err(); err != nil {
		return false, false, err
	}
	status, err := s.Status(ctx, electionID, s.now().UTC())
	if err != nil {
		return false, false, err
	}
	if status == pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND {
		return false, false, nil
	}
	return true, status == pb.ElectionStatus_ELECTION_STATUS_OPEN, nil
}

func cloneElection(config Election) Election {
	config.Options = append([]string(nil), config.Options...)
	config.EncryptionPublicKey = append([]byte(nil), config.EncryptionPublicKey...)
	config.SignedParameters = append([]byte(nil), config.SignedParameters...)
	config.ParameterSignature = append([]byte(nil), config.ParameterSignature...)
	config.TokenKeys = append([]TokenKey(nil), config.TokenKeys...)
	for i := range config.TokenKeys {
		config.TokenKeys[i] = cloneTokenKey(config.TokenKeys[i])
	}
	return config
}

func cloneTokenKey(key TokenKey) TokenKey {
	key.PublicKeyDER = append([]byte(nil), key.PublicKeyDER...)
	return key
}

func validTokenKey(key TokenKey) bool {
	if len(key.KID) == 0 || len(key.KID) > 64 || strings.TrimSpace(key.KID) != key.KID ||
		(key.SignatureVariant != token.RSABSSASHA384PSSRandomized && key.SignatureVariant != token.RSABSSASHA384PSSZeroRandomized) ||
		len(key.PublicKeyDER) == 0 || len(key.PublicKeyDER) > 16*1024 {
		return false
	}
	parsed, err := x509.ParsePKIXPublicKey(key.PublicKeyDER)
	if err != nil {
		return false
	}
	publicKey, ok := parsed.(*rsa.PublicKey)
	return ok && publicKey.N != nil && publicKey.N.BitLen() >= 2048 && publicKey.E >= 3 && publicKey.E%2 == 1
}

func sameElection(left, right Election) bool {
	return left.ID == right.ID && reflect.DeepEqual(left.Options, right.Options) &&
		reflect.DeepEqual(left.EncryptionPublicKey, right.EncryptionPublicKey) &&
		tokenKeysContain(left.TokenKeys, right.TokenKeys) && left.OpensAt.Equal(right.OpensAt) &&
		left.ClosesAt.Equal(right.ClosesAt) && reflect.DeepEqual(left.SignedParameters, right.SignedParameters) &&
		left.SigningKeyID == right.SigningKeyID && left.SignatureAlgorithm == right.SignatureAlgorithm &&
		reflect.DeepEqual(left.ParameterSignature, right.ParameterSignature)
}

func tokenKeysContain(existing, requested []TokenKey) bool {
	byKID := make(map[string]TokenKey, len(existing))
	for _, key := range existing {
		byKID[key.KID] = key
	}
	for _, key := range requested {
		if registered, ok := byKID[key.KID]; !ok || !reflect.DeepEqual(registered, key) {
			return false
		}
	}
	return true
}
