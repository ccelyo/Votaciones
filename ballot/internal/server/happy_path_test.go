package server

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
	"github.com/ccelyo/Votaciones/ballot/internal/pb"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"github.com/cloudflare/circl/blindsign/blindrsa"
)

type happyPathProofStub struct{}

func (happyPathProofStub) Verify(_ context.Context, _ string, ciphertext, proof []byte) error {
	if len(ciphertext) == 0 || string(proof) != "stub-benaloh-proof" {
		return errors.New("stub ballot proof rejected")
	}
	return nil
}

func TestHappyPathWithStubbedBrowserCrypto(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	commitStore := ballotflow.NewMemoryCommitStore()
	server := newTestGRPCServerWithClock(t, func() time.Time { return now }, commitStore)
	defer server.cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	identitySigningKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	identityPublicKeyDER, err := x509.MarshalPKIXPublicKey(&identitySigningKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	request := validRegisterRequest(t, "election-e2e")
	request.TokenVerificationKeys[0].PublicKeyDer = identityPublicKeyDER
	request.OpensAtUnixSeconds = now.Add(-time.Hour).Unix()
	request.ClosesAtUnixSeconds = now.Add(time.Hour).Unix()
	if response, err := server.client.RegisterElection(ctx, request); err != nil || !response.Created {
		t.Fatalf("register election: response=%v err=%v", response, err)
	}

	// Browser stub: a random token is election-bound, blinded, signed by the
	// identity stub, then finalized locally. Vote encryption and proof are stubs.
	tokenBytes := makeBrowserSignedToken(t, identitySigningKey, request.ElectionId, "key-1")
	ciphertext := []byte("stub-encrypted-vote")
	proof := []byte("stub-benaloh-proof")
	if len(ciphertext) == 0 || len(proof) == 0 {
		t.Fatal("browser stubs must provide an encrypted ballot and proof")
	}
	receiptPublicKey, receiptPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	acceptor := ballotflow.NewAcceptor(
		token.NewVerifier(server.store, server.store),
		happyPathProofStub{},
		commitStore,
		server.store,
		receiptPrivateKey,
	)
	receipt, spendResult, err := acceptor.Accept(ctx, request.ElectionId, tokenBytes, ciphertext, proof)
	if err != nil || spendResult != token.SpendNew {
		t.Fatalf("first vote acceptance = (%v, %v), want New", spendResult, err)
	}
	if err := token.VerifyReceipt(receiptPublicKey, receipt); err != nil {
		t.Fatalf("signed receipt did not verify: %v", err)
	}
	if err := ballotflow.VerifyBallotHash(receipt.BallotHash, request.ElectionId, ciphertext, proof, make([]byte, 32)); err != nil {
		t.Fatalf("server-generated first ballot hash is invalid: %v", err)
	}
	retryReceipt, spendResult, err := acceptor.Accept(ctx, request.ElectionId, tokenBytes, ciphertext, proof)
	if err != nil || spendResult != token.SpendReplay {
		t.Fatalf("identical network retry = (%v, %v), want Replay", spendResult, err)
	}
	firstReceiptBytes, err := token.MarshalReceipt(receipt)
	if err != nil {
		t.Fatal(err)
	}
	retryReceiptBytes, err := token.MarshalReceipt(retryReceipt)
	if err != nil {
		t.Fatal(err)
	}
	if string(firstReceiptBytes) != string(retryReceiptBytes) {
		t.Fatal("network retry returned a different receipt")
	}

	if _, _, err := acceptor.Accept(ctx, request.ElectionId, tokenBytes, []byte("different-ciphertext"), proof); !errors.Is(err, token.ErrAlreadySpent) {
		t.Fatalf("double vote error = %v, want ErrAlreadySpent", err)
	}

	alteredPrevious := make([]byte, 32)
	alteredPrevious[0] = 1
	if err := ballotflow.VerifyBallotHash(receipt.BallotHash, request.ElectionId, ciphertext, proof, alteredPrevious); !errors.Is(err, ballotflow.ErrInvalidBallotHash) {
		t.Fatalf("altered chain error = %v, want ErrInvalidBallotHash", err)
	}

	count, err := server.client.CountBallots(ctx, &pb.CountBallotsRequest{ElectionId: request.ElectionId})
	if err != nil || count.TotalBallots != 1 {
		t.Fatalf("participation count = (%v, %v), want one ballot", count, err)
	}
	closed, err := server.client.CloseElection(ctx, &pb.CloseElectionRequest{ElectionId: request.ElectionId})
	if err != nil || closed.Status != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
		t.Fatalf("close election = (%v, %v), want CLOSED", closed, err)
	}
	if _, _, err := acceptor.Accept(ctx, request.ElectionId, tokenBytes, ciphertext, proof); !errors.Is(err, token.ErrElectionClosed) {
		t.Fatalf("post-close vote error = %v, want ErrElectionClosed", err)
	}
}

func makeBrowserSignedToken(t *testing.T, identityKey *rsa.PrivateKey, electionID, kid string) []byte {
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
		KeyID:           kid,
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
