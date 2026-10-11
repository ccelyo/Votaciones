package election

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"testing"
	"time"

	"github.com/ccelyo/Votaciones/ballot/internal/pb"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
)

func validElection(t *testing.T) Election {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicKeyDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return Election{
		ID:                  "election-1",
		Options:             []string{"option-a", "option-b"},
		EncryptionPublicKey: []byte("public-election-key"),
		TokenKeys: []TokenKey{{
			KID:              "key-1",
			PublicKeyDER:     publicKeyDER,
			SignatureVariant: "RSABSSA-SHA384-PSS-Randomized",
		}},
		OpensAt:            time.Unix(2_000_000_000, 0).UTC(),
		ClosesAt:           time.Unix(2_000_003_600, 0).UTC(),
		SignedParameters:   []byte("canonical-election-parameters"),
		SigningKeyID:       "identity-key-1",
		SignatureAlgorithm: "ed25519",
		ParameterSignature: []byte("identity-signature"),
	}
}

func TestMemoryStoreRegisterIsIdempotentAndDetectsConflict(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	election := validElection(t)

	created, err := store.Register(ctx, election)
	if err != nil || !created {
		t.Fatalf("first Register = (%v, %v), want (true, nil)", created, err)
	}
	created, err = store.Register(ctx, election)
	if err != nil || created {
		t.Fatalf("identical Register = (%v, %v), want (false, nil)", created, err)
	}
	election.Options = []string{"option-a", "option-c"}
	if _, err := store.Register(ctx, election); !errors.Is(err, ErrRegistrationConflict) {
		t.Fatalf("conflicting Register error = %v, want ErrRegistrationConflict", err)
	}
}

func TestMemoryStoreStatusAndIrreversibleClose(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	if status, err := store.Status(ctx, "missing", time.Unix(2_000_000_100, 0)); err != nil || status != pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND {
		t.Fatalf("missing status = (%v, %v), want NOT_FOUND", status, err)
	}
	if _, err := store.Register(ctx, validElection(t)); err != nil {
		t.Fatal(err)
	}
	if status, err := store.Status(ctx, "election-1", time.Unix(1_999_999_999, 0)); err != nil || status != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
		t.Fatalf("pre-open status = (%v, %v), want CLOSED", status, err)
	}
	if status, err := store.Status(ctx, "election-1", time.Unix(2_000_000_100, 0)); err != nil || status != pb.ElectionStatus_ELECTION_STATUS_OPEN {
		t.Fatalf("open status = (%v, %v), want OPEN", status, err)
	}
	if status, err := store.Close(ctx, "election-1", time.Unix(2_000_000_200, 0)); err != nil || status != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
		t.Fatalf("Close = (%v, %v), want CLOSED", status, err)
	}
	if status, err := store.Status(ctx, "election-1", time.Unix(2_000_000_100, 0)); err != nil || status != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
		t.Fatalf("status after close = (%v, %v), want CLOSED", status, err)
	}
	if status, err := store.Close(ctx, "election-1", time.Unix(2_000_000_300, 0)); err != nil || status != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
		t.Fatalf("repeated Close = (%v, %v), want CLOSED", status, err)
	}
	if _, err := store.Close(ctx, "missing", time.Unix(2_000_000_300, 0)); !errors.Is(err, ErrElectionNotFound) {
		t.Fatalf("missing Close error = %v, want ErrElectionNotFound", err)
	}
}

func TestMemoryStoreCountIsParticipationOnly(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	if _, err := store.Register(ctx, validElection(t)); err != nil {
		t.Fatal(err)
	}
	if err := store.AddParticipation(ctx, "election-1"); err != nil {
		t.Fatal(err)
	}
	if err := store.AddParticipation(ctx, "election-1"); err != nil {
		t.Fatal(err)
	}
	count, err := store.Count(ctx, "election-1")
	if err != nil || count != 2 {
		t.Fatalf("Count = (%d, %v), want (2, nil)", count, err)
	}
	if _, err := store.Count(ctx, "missing"); !errors.Is(err, ErrElectionNotFound) {
		t.Fatalf("missing Count error = %v, want ErrElectionNotFound", err)
	}
}

func TestMemoryStoreResolvesCurrentAndRotatedTokenKeys(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	election := validElection(t)
	election.TokenKeys = append(election.TokenKeys, TokenKey{
		KID: "key-2", PublicKeyDER: election.TokenKeys[0].PublicKeyDER, SignatureVariant: "RSABSSA-SHA384-PSS-Randomized",
	})
	if _, err := store.Register(ctx, election); err != nil {
		t.Fatal(err)
	}
	for _, kid := range []string{"key-1", "key-2"} {
		if _, ok, err := store.ResolveTokenKey(ctx, "election-1", kid); err != nil || !ok {
			t.Fatalf("ResolveTokenKey(%q) = (ok=%v, err=%v), want true", kid, ok, err)
		}
	}
	if _, ok, err := store.ResolveTokenKey(ctx, "election-2", "key-1"); err != nil || ok {
		t.Fatalf("cross-election key lookup = (ok=%v, err=%v), want false", ok, err)
	}
}

func TestMemoryStoreRegistrationStaysIdempotentAfterKeyRotation(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	original := validElection(t)
	if _, err := store.Register(ctx, original); err != nil {
		t.Fatal(err)
	}
	newKey := validElection(t).TokenKeys[0]
	newKey.KID = "key-2"
	if created, err := store.AddTokenVerificationKey(ctx, original.ID, newKey); err != nil || !created {
		t.Fatalf("AddTokenVerificationKey = (created=%v, err=%v), want created", created, err)
	}
	if created, err := store.Register(ctx, original); err != nil || created {
		t.Fatalf("re-register initial config after rotation = (created=%v, err=%v), want idempotent", created, err)
	}
}

func TestMemoryStoreHonorsCanceledContext(t *testing.T) {
	store := NewMemoryStore()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Register(ctx, validElection(t)); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Register error = %v, want context.Canceled", err)
	}
}

func TestCloseWaitsForCommitAndBlocksCommitsAfterward(t *testing.T) {
	now := time.Unix(2_000_000_100, 0).UTC()
	store := NewMemoryStoreWithClock(func() time.Time { return now })
	if _, err := store.Register(context.Background(), validElection(t)); err != nil {
		t.Fatal(err)
	}
	commitStarted := make(chan struct{})
	finishCommit := make(chan struct{})
	commitDone := make(chan error, 1)
	go func() {
		commitDone <- store.CommitWhileOpen(context.Background(), "election-1", func() error {
			close(commitStarted)
			<-finishCommit
			return nil
		})
	}()
	<-commitStarted

	closeStarted := make(chan struct{})
	closeDone := make(chan error, 1)
	go func() {
		close(closeStarted)
		_, err := store.Close(context.Background(), "election-1", now)
		closeDone <- err
	}()
	<-closeStarted
	select {
	case err := <-closeDone:
		t.Fatalf("Close returned while a ballot commit was in flight: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(finishCommit)
	if err := <-commitDone; err != nil {
		t.Fatalf("in-flight commit failed: %v", err)
	}
	if err := <-closeDone; err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	if err := store.CommitWhileOpen(context.Background(), "election-1", func() error { return nil }); !errors.Is(err, token.ErrElectionClosed) {
		t.Fatalf("commit after close error = %v, want ErrElectionClosed", err)
	}
}
