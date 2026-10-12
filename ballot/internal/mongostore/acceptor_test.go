package mongostore

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"testing"
	"time"

	ballotflow "github.com/ccelyo/Votaciones/ballot/internal/ballot"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"github.com/cloudflare/circl/blindsign/blindrsa"
)

func TestAcceptorHappyPathOnMongo(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	identityKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	config := testElection(t, "gobernacion-e2e")
	if config.TokenKeys[0].PublicKeyDER, err = x509.MarshalPKIXPublicKey(&identityKey.PublicKey); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Register(ctx, config); err != nil {
		t.Fatal(err)
	}
	receiptPublic, receiptPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	acceptor := ballotflow.NewAcceptor(token.NewVerifier(store, store), ballotflow.StructuralProofVerifier{}, store, store, receiptPrivate)
	signed := browserToken(t, identityKey, config.ID)

	receipt, result, err := acceptor.Accept(ctx, config.ID, signed, []byte("ciphertext"), []byte("proof"))
	if err != nil || result != token.SpendNew {
		t.Fatalf("Accept = (%v, %v)", result, err)
	}
	if err := token.VerifyReceipt(receiptPublic, receipt); err != nil {
		t.Fatal(err)
	}
	if _, result, err := acceptor.Accept(ctx, config.ID, signed, []byte("ciphertext"), []byte("proof")); err != nil || result != token.SpendReplay {
		t.Fatalf("replay = (%v, %v)", result, err)
	}
	if _, _, err := acceptor.Accept(ctx, config.ID, signed, []byte("other"), []byte("proof")); !errors.Is(err, token.ErrAlreadySpent) {
		t.Fatalf("double vote error = %v", err)
	}
	if _, err := store.Close(ctx, config.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := acceptor.Accept(ctx, config.ID, browserToken(t, identityKey, config.ID), []byte("late"), []byte("proof")); !errors.Is(err, token.ErrElectionClosed) {
		t.Fatalf("post-close error = %v", err)
	}
	if count, err := store.Count(ctx, config.ID); err != nil || count != 1 {
		t.Fatalf("Count = (%d, %v), want 1", count, err)
	}
}

func browserToken(t *testing.T, identityKey *rsa.PrivateKey, electionID string) []byte {
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
		Version: token.TokenVersion, KeyID: "key-1", ElectionID: electionID,
		Nonce: nonce, PreparedMessage: prepared, Signature: signature,
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
