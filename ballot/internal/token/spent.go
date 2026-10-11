package token

import (
	"context"
	"encoding/hex"
	"sync"
)

// SpendResult is the atomic result of attempting to consume a token.
type SpendResult uint8

const (
	// SpendNew means this token was first used for this ballot.
	SpendNew SpendResult = iota + 1
	// SpendReplay means this exact token and ballot were already recorded.
	SpendReplay
	// SpendConflict means the token is already associated with another ballot.
	SpendConflict
)

// SpentTokenStore atomically associates a token with one election and ballot hash.
// A Mongo adapter must use the token hash as its unique _id and include the ballot
// in the same atomic insert/transaction. This contract is pending M7 agreement.
type SpentTokenStore interface {
	MarkSpent(ctx context.Context, electionID, tokenID, ballotHash string) (SpendResult, error)
}

type spentEntry struct {
	electionID string
	ballotHash string
}

// MemorySpentTokenStore is a concurrency-safe fake for unit and integration tests.
type MemorySpentTokenStore struct {
	mu      sync.Mutex
	entries map[string]spentEntry
}

// NewMemorySpentTokenStore constructs an empty in-memory spent-token store.
func NewMemorySpentTokenStore() *MemorySpentTokenStore {
	return &MemorySpentTokenStore{entries: make(map[string]spentEntry)}
}

// MarkSpent atomically returns New, Replay, or Conflict for one token digest.
func (s *MemorySpentTokenStore) MarkSpent(ctx context.Context, electionID, tokenID, ballotHash string) (SpendResult, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if s == nil || !validIdentifier(electionID, 128) || !isSHA256Hex(tokenID) || !isSHA256Hex(ballotHash) {
		return 0, ErrInvalidSpend
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if existing, ok := s.entries[tokenID]; ok {
		if existing.electionID == electionID && existing.ballotHash == ballotHash {
			return SpendReplay, nil
		}
		return SpendConflict, nil
	}
	s.entries[tokenID] = spentEntry{electionID: electionID, ballotHash: ballotHash}
	return SpendNew, nil
}

func isSHA256Hex(value string) bool {
	if len(value) != 2*BallotHashSize {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == BallotHashSize && hex.EncodeToString(decoded) == value
}
