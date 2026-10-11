package ballot

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"

	"github.com/ccelyo/Votaciones/ballot/internal/token"
)

var ErrInvalidBallot = errors.New("invalid ballot")

// BallotSubmission contains only fields supplied by the browser/HTTP handler.
// The client does not choose the previous chain hash.
type BallotSubmission struct {
	ElectionID    string
	TokenID       string
	EncryptedVote []byte
	Proof         []byte
}

// BallotRecord is the complete anonymized document stored for one ballot.
type BallotRecord struct {
	ElectionID    string
	TokenID       string
	EncryptedVote []byte
	Proof         []byte
	PreviousHash  []byte
	BallotHash    []byte
}

// CommitStore atomically inserts one whole ballot document keyed by TokenID.
// Mongo must use TokenID as the unique _id and perform insert-only writes.
// This extension is proposed for agreement with M7; MarkSpent alone cannot
// atomically persist the ciphertext, proof and hash-chain fields.
type CommitStore interface {
	// Commit atomically assigns the next chain hash and inserts one complete
	// ballot. A same-token/same-payload retry returns the original record.
	Commit(ctx context.Context, submission BallotSubmission) (BallotRecord, token.SpendResult, error)
}

// ElectionCommitGate serializes a ballot commit against irreversible closure.
// Implementations must not release the open-election guard until commit returns.
type ElectionCommitGate interface {
	CommitWhileOpen(ctx context.Context, electionID string, commit func() error) error
}

// ProofVerifier validates the ciphertext proof supplied by the browser.
// Production proof verification remains a separately agreed M7 contract.
type ProofVerifier interface {
	Verify(ctx context.Context, electionID string, encryptedVote, proof []byte) error
}

// Acceptor composes token verification, proof validation, atomic ballot commit,
// and receipt signing. It is called by M7's HTTP handler after request parsing.
type Acceptor struct {
	verifier   *token.Verifier
	proofs     ProofVerifier
	store      CommitStore
	gate       ElectionCommitGate
	receiptKey ed25519.PrivateKey
}

// NewAcceptor creates a ballot acceptance pipeline with no identity data input.
func NewAcceptor(verifier *token.Verifier, proofs ProofVerifier, store CommitStore, gate ElectionCommitGate, receiptKey ed25519.PrivateKey) *Acceptor {
	return &Acceptor{
		verifier:   verifier,
		proofs:     proofs,
		store:      store,
		gate:       gate,
		receiptKey: append(ed25519.PrivateKey(nil), receiptKey...),
	}
}

// Accept validates an anonymous token and encrypted-ballot proof, atomically
// stores the ballot with the next server-selected chain hash, then returns a
// deterministic receipt. The caller never supplies the previous hash.
func (a *Acceptor) Accept(ctx context.Context, electionID string, encodedToken, encryptedVote, proof []byte) (token.SignedReceipt, token.SpendResult, error) {
	if err := ctx.Err(); err != nil {
		return token.SignedReceipt{}, 0, err
	}
	if a == nil || a.verifier == nil || a.proofs == nil || a.store == nil || a.gate == nil || len(a.receiptKey) != ed25519.PrivateKeySize {
		return token.SignedReceipt{}, 0, ErrInvalidBallot
	}
	if _, err := ComputeBallotHash(electionID, encryptedVote, proof, make([]byte, 32)); err != nil {
		return token.SignedReceipt{}, 0, err
	}
	if err := a.verifier.Verify(ctx, electionID, encodedToken); err != nil {
		return token.SignedReceipt{}, 0, err
	}
	if err := a.proofs.Verify(ctx, electionID, encryptedVote, proof); err != nil {
		return token.SignedReceipt{}, 0, err
	}
	if err := ctx.Err(); err != nil {
		return token.SignedReceipt{}, 0, err
	}
	submission := BallotSubmission{
		ElectionID:    electionID,
		TokenID:       token.TokenID(encodedToken),
		EncryptedVote: append([]byte(nil), encryptedVote...),
		Proof:         append([]byte(nil), proof...),
	}
	var result token.SpendResult
	var record BallotRecord
	err := a.gate.CommitWhileOpen(ctx, electionID, func() error {
		var commitErr error
		record, result, commitErr = a.store.Commit(ctx, submission)
		return commitErr
	})
	if err != nil {
		if errors.Is(err, token.ErrElectionClosed) {
			return token.SignedReceipt{}, 0, token.ErrElectionClosed
		}
		return token.SignedReceipt{}, 0, err
	}
	if result == token.SpendConflict {
		return token.SignedReceipt{}, result, token.ErrAlreadySpent
	}
	if result != token.SpendNew && result != token.SpendReplay {
		return token.SignedReceipt{}, 0, ErrInvalidBallot
	}
	if record.TokenID != submission.TokenID || record.ElectionID != electionID ||
		!bytes.Equal(record.EncryptedVote, submission.EncryptedVote) || !bytes.Equal(record.Proof, submission.Proof) ||
		VerifyBallotHash(record.BallotHash, electionID, record.EncryptedVote, record.Proof, record.PreviousHash) != nil {
		return token.SignedReceipt{}, 0, ErrInvalidBallot
	}
	receipt, err := token.SignReceipt(a.receiptKey, electionID, record.BallotHash)
	if err != nil {
		return token.SignedReceipt{}, 0, err
	}
	return receipt, result, nil
}

// MemoryCommitStore is a test fake that stores each complete ballot once.
type MemoryCommitStore struct {
	mu        sync.Mutex
	records   map[string]BallotRecord
	chainHead map[string][]byte
}

// NewMemoryCommitStore constructs an empty atomic ballot fake.
func NewMemoryCommitStore() *MemoryCommitStore {
	return &MemoryCommitStore{records: make(map[string]BallotRecord), chainHead: make(map[string][]byte)}
}

// Commit atomically selects the prior hash, builds the record and detects replay
// or token conflict. The memory adapter serializes commits in this process.
func (s *MemoryCommitStore) Commit(ctx context.Context, submission BallotSubmission) (BallotRecord, token.SpendResult, error) {
	if err := ctx.Err(); err != nil {
		return BallotRecord{}, 0, err
	}
	if s == nil || !validElectionID(submission.ElectionID) || len(submission.TokenID) != sha256.Size*2 ||
		len(submission.EncryptedVote) == 0 || len(submission.EncryptedVote) > maxEncryptedBytes ||
		len(submission.Proof) == 0 || len(submission.Proof) > maxProofBytes {
		return BallotRecord{}, 0, ErrInvalidBallot
	}
	decodedTokenID, err := hex.DecodeString(submission.TokenID)
	if err != nil || len(decodedTokenID) != sha256.Size || hex.EncodeToString(decodedTokenID) != submission.TokenID {
		return BallotRecord{}, 0, ErrInvalidBallot
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return BallotRecord{}, 0, err
	}
	if s.records == nil {
		s.records = make(map[string]BallotRecord)
	}
	if s.chainHead == nil {
		s.chainHead = make(map[string][]byte)
	}
	if existing, ok := s.records[submission.TokenID]; ok {
		if sameSubmission(existing, submission) {
			return cloneBallotRecord(existing), token.SpendReplay, nil
		}
		return BallotRecord{}, token.SpendConflict, nil
	}
	previousHash := append([]byte(nil), s.chainHead[submission.ElectionID]...)
	if len(previousHash) == 0 {
		previousHash = make([]byte, sha256.Size)
	}
	ballotHash, err := ComputeBallotHash(submission.ElectionID, submission.EncryptedVote, submission.Proof, previousHash)
	if err != nil {
		return BallotRecord{}, 0, err
	}
	if err := ctx.Err(); err != nil {
		return BallotRecord{}, 0, err
	}
	record := BallotRecord{
		ElectionID:    submission.ElectionID,
		TokenID:       submission.TokenID,
		EncryptedVote: append([]byte(nil), submission.EncryptedVote...),
		Proof:         append([]byte(nil), submission.Proof...),
		PreviousHash:  previousHash,
		BallotHash:    append([]byte(nil), ballotHash[:]...),
	}
	s.records[submission.TokenID] = cloneBallotRecord(record)
	s.chainHead[submission.ElectionID] = append([]byte(nil), ballotHash[:]...)
	return cloneBallotRecord(record), token.SpendNew, nil
}

// Count returns only the number of stored participation records for an election.
func (s *MemoryCommitStore) Count(electionID string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var count uint64
	for _, record := range s.records {
		if record.ElectionID == electionID {
			count++
		}
	}
	return count
}

// CountBallots implements election.ParticipationCounter and returns no vote contents.
func (s *MemoryCommitStore) CountBallots(ctx context.Context, electionID string) (uint64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return s.Count(electionID), nil
}

func sameSubmission(record BallotRecord, submission BallotSubmission) bool {
	return record.ElectionID == submission.ElectionID && bytes.Equal(record.EncryptedVote, submission.EncryptedVote) &&
		bytes.Equal(record.Proof, submission.Proof)
}

func cloneBallotRecord(record BallotRecord) BallotRecord {
	record.EncryptedVote = append([]byte(nil), record.EncryptedVote...)
	record.Proof = append([]byte(nil), record.Proof...)
	record.PreviousHash = append([]byte(nil), record.PreviousHash...)
	record.BallotHash = append([]byte(nil), record.BallotHash...)
	return record
}
