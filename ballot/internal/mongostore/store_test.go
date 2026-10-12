package mongostore

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	ballotflow "github.com/ccelyo/Votaciones/ballot/internal/ballot"
	"github.com/ccelyo/Votaciones/ballot/internal/election"
	"github.com/ccelyo/Votaciones/ballot/internal/pb"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
)

// newTestStore needs a replica-set MongoDB, e.g.
// MONGODB_TEST_URI="mongodb://localhost:27017/?replicaSet=rs0&directConnection=true".
func newTestStore(t *testing.T) *Store {
	t.Helper()
	uri := os.Getenv("MONGODB_TEST_URI")
	if uri == "" {
		t.Skip("MONGODB_TEST_URI not set; skipping MongoDB integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	database := "ballot_test_" + randomHex(t, 6)
	store, err := Connect(ctx, uri, database)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureIndexes(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = store.client.Database(database).Drop(ctx)
		_ = store.Disconnect(ctx)
	})
	return store
}

func TestCommitChainsReplaysAndConflicts(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	registerOpenElection(t, store, "election-1")
	first := submission("election-1", "token-1", "cipher-1")
	record, result, err := store.Commit(ctx, first)
	if err != nil || result != token.SpendNew {
		t.Fatalf("first commit = (%v, %v)", result, err)
	}
	if !bytes.Equal(record.PreviousHash, make([]byte, 32)) {
		t.Fatal("first ballot must link to the zero hash")
	}
	replay, result, err := store.Commit(ctx, first)
	if err != nil || result != token.SpendReplay || !bytes.Equal(replay.BallotHash, record.BallotHash) {
		t.Fatalf("replay = (%v, %v)", result, err)
	}
	if _, result, err := store.Commit(ctx, submission("election-1", "token-1", "other")); err != nil || result != token.SpendConflict {
		t.Fatalf("conflict = (%v, %v)", result, err)
	}
	second, result, err := store.Commit(ctx, submission("election-1", "token-2", "cipher-2"))
	if err != nil || result != token.SpendNew {
		t.Fatalf("second commit = (%v, %v)", result, err)
	}
	if !bytes.Equal(second.PreviousHash, record.BallotHash) {
		t.Fatal("second ballot does not link to the first")
	}
	if count, err := store.CountBallots(ctx, "election-1"); err != nil || count != 2 {
		t.Fatalf("count = (%d, %v), want 2", count, err)
	}
}

func TestConcurrentCommitsFormSingleChain(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	registerOpenElection(t, store, "election-c")
	const workers = 16
	var wait sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			_, result, err := store.Commit(ctx, submission("election-c", fmt.Sprintf("token-%d", i), fmt.Sprintf("cipher-%d", i)))
			if err == nil && result != token.SpendNew {
				err = fmt.Errorf("result %v", result)
			}
			errs <- err
		}(i)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	cursor, err := store.ballots.Find(ctx, map[string]string{"election_id": "election-c"})
	if err != nil {
		t.Fatal(err)
	}
	var documents []ballotDocument
	if err := cursor.All(ctx, &documents); err != nil {
		t.Fatal(err)
	}
	bySeq := make(map[int64]ballotDocument, len(documents))
	for _, document := range documents {
		bySeq[document.Seq] = document
	}
	previous := make([]byte, 32)
	for seq := int64(1); seq <= workers; seq++ {
		document, ok := bySeq[seq]
		if !ok {
			t.Fatalf("missing seq %d", seq)
		}
		if !bytes.Equal(document.PreviousHash, previous) {
			t.Fatalf("seq %d does not link to seq %d", seq, seq-1)
		}
		if err := ballotflow.VerifyBallotHash(document.BallotHash, document.ElectionID, document.EncryptedVote, document.Proof, document.PreviousHash); err != nil {
			t.Fatalf("seq %d hash invalid: %v", seq, err)
		}
		previous = document.BallotHash
	}
	if count, err := store.Count(ctx, "election-c"); err != nil || count != workers {
		t.Fatalf("Count = (%d, %v), want %d", count, err, workers)
	}
}

func TestCommitRejectsUnknownElection(t *testing.T) {
	store := newTestStore(t)
	if _, _, err := store.Commit(context.Background(), submission("missing", "token-1", "cipher")); !errors.Is(err, token.ErrWrongElection) {
		t.Fatalf("unknown election error = %v, want ErrWrongElection", err)
	}
}

func TestNoBallotCommitsAfterCloseReturns(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	registerOpenElection(t, store, "election-close")

	const workers = 24
	var wait sync.WaitGroup
	var committed atomic.Int64
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			<-start
			_, result, err := store.Commit(ctx, submission("election-close", fmt.Sprintf("token-%d", i), fmt.Sprintf("cipher-%d", i)))
			if err == nil && result == token.SpendNew {
				committed.Add(1)
			} else if err != nil && !errors.Is(err, token.ErrElectionClosed) {
				t.Errorf("commit %d: unexpected error %v", i, err)
			}
		}(i)
	}
	close(start)
	if _, err := store.Close(ctx, "election-close", time.Now()); err != nil {
		t.Fatal(err)
	}
	countAtClose, err := store.Count(ctx, "election-close")
	if err != nil {
		t.Fatal(err)
	}
	wait.Wait()
	countAfter, err := store.Count(ctx, "election-close")
	if err != nil {
		t.Fatal(err)
	}
	stored, err := store.CountBallots(ctx, "election-close")
	if err != nil {
		t.Fatal(err)
	}
	if countAfter != countAtClose || stored != countAtClose || uint64(committed.Load()) != countAtClose {
		t.Fatalf("ballots changed after Close returned: atClose=%d after=%d stored=%d committed=%d", countAtClose, countAfter, stored, committed.Load())
	}
	if _, _, err := store.Commit(ctx, submission("election-close", "late-token", "late")); !errors.Is(err, token.ErrElectionClosed) {
		t.Fatalf("post-close commit error = %v, want ErrElectionClosed", err)
	}
}

func TestElectionLifecycle(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	config := testElection(t, "election-life")
	if created, err := store.Register(ctx, config); err != nil || !created {
		t.Fatalf("Register = (%v, %v)", created, err)
	}
	if created, err := store.Register(ctx, config); err != nil || created {
		t.Fatalf("identical Register = (%v, %v), want (false, nil)", created, err)
	}
	conflicting := config
	conflicting.Options = []string{"otra"}
	if _, err := store.Register(ctx, conflicting); !errors.Is(err, election.ErrRegistrationConflict) {
		t.Fatalf("conflicting Register error = %v", err)
	}

	parameters, err := store.Parameters(ctx, "election-life")
	if err != nil || !election.SameRegistration(parameters, config) {
		t.Fatalf("Parameters round trip failed: %v", err)
	}
	if status, err := store.Status(ctx, "election-life", time.Now()); err != nil || status != pb.ElectionStatus_ELECTION_STATUS_OPEN {
		t.Fatalf("Status = (%v, %v), want OPEN", status, err)
	}
	if status, err := store.Status(ctx, "missing", time.Now()); err != nil || status != pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND {
		t.Fatalf("missing Status = (%v, %v)", status, err)
	}

	rotated := election.TokenKey{KID: "key-2", PublicKeyDER: config.TokenKeys[0].PublicKeyDER, SignatureVariant: token.RSABSSASHA384PSSRandomized}
	if created, err := store.AddTokenVerificationKey(ctx, "election-life", rotated); err != nil || !created {
		t.Fatalf("AddTokenVerificationKey = (%v, %v)", created, err)
	}
	if created, err := store.AddTokenVerificationKey(ctx, "election-life", rotated); err != nil || created {
		t.Fatalf("repeated AddTokenVerificationKey = (%v, %v)", created, err)
	}
	for _, kid := range []string{"key-1", "key-2"} {
		if _, found, err := store.ResolveTokenKey(ctx, "election-life", kid); err != nil || !found {
			t.Fatalf("ResolveTokenKey(%s) = (%v, %v)", kid, found, err)
		}
	}
	if created, err := store.Register(ctx, config); err != nil || created {
		t.Fatalf("Register after rotation = (%v, %v), want idempotent", created, err)
	}

	if status, err := store.Close(ctx, "election-life", time.Now()); err != nil || status != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
		t.Fatalf("Close = (%v, %v)", status, err)
	}
	if exists, open, err := store.ElectionState(ctx, "election-life"); err != nil || !exists || open {
		t.Fatalf("ElectionState after close = (%v, %v, %v)", exists, open, err)
	}
	if _, err := store.AddTokenVerificationKey(ctx, "election-life", election.TokenKey{KID: "key-3", PublicKeyDER: rotated.PublicKeyDER, SignatureVariant: rotated.SignatureVariant}); !errors.Is(err, token.ErrElectionClosed) {
		t.Fatalf("key after close error = %v", err)
	}
	if _, err := store.Close(ctx, "missing", time.Now()); !errors.Is(err, election.ErrElectionNotFound) {
		t.Fatalf("missing Close error = %v", err)
	}
}

func registerOpenElection(t *testing.T, store *Store, electionID string) {
	t.Helper()
	if _, err := store.Register(context.Background(), testElection(t, electionID)); err != nil {
		t.Fatal(err)
	}
}

var (
	testKeyOnce sync.Once
	testKeyDER  []byte
)

func testElection(t *testing.T, electionID string) election.Election {
	t.Helper()
	testKeyOnce.Do(func() {
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err == nil {
			testKeyDER, err = x509.MarshalPKIXPublicKey(&key.PublicKey)
		}
		if err != nil {
			t.Fatal(err)
		}
	})
	now := time.Now().UTC().Truncate(time.Second)
	return election.Election{
		ID:                  electionID,
		Options:             []string{"candidato-1", "candidato-2", "voto-en-blanco"},
		EncryptionPublicKey: []byte("election-public-key"),
		TokenKeys:           []election.TokenKey{{KID: "key-1", PublicKeyDER: testKeyDER, SignatureVariant: token.RSABSSASHA384PSSRandomized}},
		OpensAt:             now.Add(-time.Hour),
		ClosesAt:            now.Add(time.Hour),
		SignedParameters:    []byte("signed-parameters"),
		SigningKeyID:        "params-1",
		SignatureAlgorithm:  "Ed25519",
		ParameterSignature:  []byte("signature"),
	}
}

func submission(electionID, tokenSeed, ciphertext string) ballotflow.BallotSubmission {
	return ballotflow.BallotSubmission{
		ElectionID:    electionID,
		TokenID:       token.TokenID([]byte(tokenSeed)),
		EncryptedVote: []byte(ciphertext),
		Proof:         []byte("proof"),
	}
}

func randomHex(t *testing.T, size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(buffer)
}
