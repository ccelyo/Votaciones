package token

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
)

func TestSignAndVerifyReceipt(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ballotHash := make([]byte, BallotHashSize)
	if _, err := rand.Read(ballotHash); err != nil {
		t.Fatal(err)
	}

	first, err := SignReceipt(privateKey, "election-1", ballotHash)
	if err != nil {
		t.Fatal(err)
	}
	second, err := SignReceipt(privateKey, "election-1", ballotHash)
	if err != nil {
		t.Fatal(err)
	}
	if string(first.Signature) != string(second.Signature) {
		t.Fatal("identical receipt payloads must produce the same Ed25519 signature")
	}
	if err := VerifyReceipt(publicKey, first); err != nil {
		t.Fatalf("valid receipt rejected: %v", err)
	}
	encoded, err := MarshalReceipt(first)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseReceipt(encoded)
	if err != nil {
		t.Fatalf("valid receipt envelope rejected: %v", err)
	}
	if err := VerifyReceipt(publicKey, parsed); err != nil {
		t.Fatalf("parsed receipt rejected: %v", err)
	}
	first.ElectionID = "election-2"
	if err := VerifyReceipt(publicKey, first); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("receipt with changed election error = %v, want ErrInvalidReceipt", err)
	}
}

func TestVerifyReceiptRejectsAlteredHashOrSignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ballotHash := make([]byte, BallotHashSize)
	if _, err := rand.Read(ballotHash); err != nil {
		t.Fatal(err)
	}
	receipt, err := SignReceipt(privateKey, "election-1", ballotHash)
	if err != nil {
		t.Fatal(err)
	}
	receipt.BallotHash[0] ^= 1
	if err := VerifyReceipt(publicKey, receipt); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("altered ballot hash error = %v, want ErrInvalidReceipt", err)
	}

	receipt, err = SignReceipt(privateKey, "election-1", ballotHash)
	if err != nil {
		t.Fatal(err)
	}
	receipt.Signature[0] ^= 1
	if err := VerifyReceipt(publicKey, receipt); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("altered signature error = %v, want ErrInvalidReceipt", err)
	}
}

func TestReceiptKeyLoadsFromEnvironment(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(ReceiptPrivateKeyEnv, base64.RawURLEncoding.EncodeToString(privateKey))
	loaded, err := LoadReceiptPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(loaded) != string(privateKey) {
		t.Fatal("loaded receipt key differs from configured key")
	}
	t.Setenv(ReceiptPrivateKeyEnv, "")
	if _, err := LoadReceiptPrivateKey(); !errors.Is(err, ErrMissingReceiptKey) {
		t.Fatalf("missing key error = %v, want ErrMissingReceiptKey", err)
	}
}
