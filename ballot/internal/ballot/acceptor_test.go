package ballot

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"github.com/cloudflare/circl/blindsign/blindrsa"
)

type acceptanceTestKeys map[string]token.VerificationKey

func (keys acceptanceTestKeys) ResolveTokenKey(_ context.Context, _ string, kid string) (token.VerificationKey, bool, error) {
	key, ok := keys[kid]
	return key, ok, nil
}

type acceptanceTestState struct {
	exists bool
	open   bool
}

func (state acceptanceTestState) ElectionState(context.Context, string) (bool, bool, error) {
	return state.exists, state.open, nil
}

func (state acceptanceTestState) CommitWhileOpen(_ context.Context, _ string, commit func() error) error {
	if !state.exists {
		return token.ErrWrongElection
	}
	if !state.open {
		return token.ErrElectionClosed
	}
	return commit()
}

type testProofVerifier struct {
	err error
}

func (v testProofVerifier) Verify(context.Context, string, []byte, []byte) error {
	return v.err
}

func TestAcceptorCommitsBallotAndReturnsStableReceipt(t *testing.T) {
	identityKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	receiptPublicKey, receiptPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier := token.NewVerifier(acceptanceTestKeys{
		"key-1": {PublicKey: &identityKey.PublicKey, Variant: token.RSABSSASHA384PSSRandomized},
	}, acceptanceTestState{exists: true, open: true})
	store := NewMemoryCommitStore()
	acceptor := NewAcceptor(verifier, testProofVerifier{}, store, acceptanceTestState{exists: true, open: true}, receiptPrivateKey)
	tokenBytes := makeSignedTestToken(t, identityKey, "election-1")
	ciphertext := []byte("encrypted-ballot")
	proof := []byte("valid-proof")

	first, result, err := acceptor.Accept(context.Background(), "election-1", tokenBytes, ciphertext, proof)
	if err != nil || result != token.SpendNew {
		t.Fatalf("first Accept = (%v, %v), want New", result, err)
	}
	if err := token.VerifyReceipt(receiptPublicKey, first); err != nil {
		t.Fatalf("receipt verification failed: %v", err)
	}
	replay, result, err := acceptor.Accept(context.Background(), "election-1", tokenBytes, ciphertext, proof)
	if err != nil || result != token.SpendReplay {
		t.Fatalf("identical retry = (%v, %v), want Replay", result, err)
	}
	firstBytes, err := token.MarshalReceipt(first)
	if err != nil {
		t.Fatal(err)
	}
	replayBytes, err := token.MarshalReceipt(replay)
	if err != nil {
		t.Fatal(err)
	}
	if string(firstBytes) != string(replayBytes) {
		t.Fatal("identical retry did not return the same receipt")
	}
	if count := store.Count("election-1"); count != 1 {
		t.Fatalf("stored ballot count = %d, want 1", count)
	}

	if _, _, err := acceptor.Accept(context.Background(), "election-1", tokenBytes, []byte("other-ballot"), proof); !errors.Is(err, token.ErrAlreadySpent) {
		t.Fatalf("same token with different ballot error = %v, want ErrAlreadySpent", err)
	}
}

func TestMemoryCommitStoreBuildsHashChainInCommitOrder(t *testing.T) {
	store := NewMemoryCommitStore()
	first, result, err := store.Commit(context.Background(), BallotSubmission{
		ElectionID: "election-1", TokenID: token.TokenID([]byte("token-1")),
		EncryptedVote: []byte("cipher-1"), Proof: []byte("proof-1"),
	})
	if err != nil || result != token.SpendNew {
		t.Fatalf("first commit = (result=%v, err=%v), want New", result, err)
	}
	if err := VerifyBallotHash(first.BallotHash, first.ElectionID, first.EncryptedVote, first.Proof, first.PreviousHash); err != nil {
		t.Fatalf("first ballot hash invalid: %v", err)
	}
	if !bytes.Equal(first.PreviousHash, make([]byte, 32)) {
		t.Fatal("first ballot must link to the zero hash")
	}
	second, result, err := store.Commit(context.Background(), BallotSubmission{
		ElectionID: "election-1", TokenID: token.TokenID([]byte("token-2")),
		EncryptedVote: []byte("cipher-2"), Proof: []byte("proof-2"),
	})
	if err != nil || result != token.SpendNew {
		t.Fatalf("second commit = (result=%v, err=%v), want New", result, err)
	}
	if !bytes.Equal(second.PreviousHash, first.BallotHash) {
		t.Fatal("second ballot does not link to the first committed ballot")
	}
	if err := VerifyBallotHash(second.BallotHash, second.ElectionID, second.EncryptedVote, second.Proof, second.PreviousHash); err != nil {
		t.Fatalf("second ballot hash invalid: %v", err)
	}
}

func TestAcceptorRejectsBadProofBeforeCommit(t *testing.T) {
	identityKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	_, receiptPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store := NewMemoryCommitStore()
	gate := acceptanceTestState{exists: true, open: true}
	acceptor := NewAcceptor(token.NewVerifier(acceptanceTestKeys{
		"key-1": {PublicKey: &identityKey.PublicKey, Variant: token.RSABSSASHA384PSSRandomized},
	}, gate), testProofVerifier{err: errors.New("invalid proof")}, store, gate, receiptPrivateKey)
	if _, _, err := acceptor.Accept(context.Background(), "election-1", makeSignedTestToken(t, identityKey, "election-1"), []byte("encrypted"), []byte("bad-proof")); err == nil {
		t.Fatal("invalid proof was accepted")
	}
	if count := store.Count("election-1"); count != 0 {
		t.Fatalf("invalid proof stored %d ballots, want zero", count)
	}
}

func TestAcceptorConcurrentSameBallotCommitsOnce(t *testing.T) {
	identityKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	_, receiptPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store := NewMemoryCommitStore()
	gate := acceptanceTestState{exists: true, open: true}
	acceptor := NewAcceptor(token.NewVerifier(acceptanceTestKeys{
		"key-1": {PublicKey: &identityKey.PublicKey, Variant: token.RSABSSASHA384PSSRandomized},
	}, gate), testProofVerifier{}, store, gate, receiptPrivateKey)
	tokenBytes := makeSignedTestToken(t, identityKey, "election-1")
	const workers = 32
	var newCount atomic.Int32
	var replayCount atomic.Int32
	var failureCount atomic.Int32
	var receiptMu sync.Mutex
	var firstReceipt []byte
	var wait sync.WaitGroup
	wait.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wait.Done()
			receipt, result, err := acceptor.Accept(context.Background(), "election-1", tokenBytes, []byte("ciphertext"), []byte("proof"))
			if err != nil {
				failureCount.Add(1)
				return
			}
			encoded, err := token.MarshalReceipt(receipt)
			if err != nil {
				failureCount.Add(1)
				return
			}
			receiptMu.Lock()
			if firstReceipt == nil {
				firstReceipt = encoded
			} else if string(firstReceipt) != string(encoded) {
				failureCount.Add(1)
			}
			receiptMu.Unlock()
			switch result {
			case token.SpendNew:
				newCount.Add(1)
			case token.SpendReplay:
				replayCount.Add(1)
			default:
				failureCount.Add(1)
			}
		}()
	}
	wait.Wait()
	if newCount.Load() != 1 || replayCount.Load() != workers-1 || failureCount.Load() != 0 {
		t.Fatalf("concurrent results: new=%d replay=%d failures=%d", newCount.Load(), replayCount.Load(), failureCount.Load())
	}
	if count := store.Count("election-1"); count != 1 {
		t.Fatalf("stored ballot count = %d, want 1", count)
	}
}

func makeSignedTestToken(t *testing.T, identityKey *rsa.PrivateKey, electionID string) []byte {
	t.Helper()
	nonce := make([]byte, token.TokenNonceSize)
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	message, err := token.CanonicalTokenMessage(electionID, nonce)
	if err != nil {
		t.Fatal(err)
	}
	client, err := blindrsa.NewClient(blindrsa.SHA384PSSRandomized, &identityKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := client.Prepare(rand.Reader, message)
	if err != nil {
		t.Fatal(err)
	}
	blinded, state, err := client.Blind(rand.Reader, prepared)
	if err != nil {
		t.Fatal(err)
	}
	blindSignature, err := blindrsa.NewSigner(identityKey).BlindSign(blinded)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := client.Finalize(state, blindSignature)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := token.MarshalSignedToken(token.SignedToken{
		Version:         token.TokenVersion,
		KeyID:           "key-1",
		ElectionID:      electionID,
		Nonce:           nonce,
		PreparedMessage: prepared,
		Signature:       signature,
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
