package ballot

import (
	"errors"
	"testing"
)

func TestBallotHashChainDetectsAlteredFields(t *testing.T) {
	previous := make([]byte, 32)
	ciphertext := []byte("stub-ciphertext")
	proof := []byte("stub-proof")
	hash, err := ComputeBallotHash("election-1", ciphertext, proof, previous)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyBallotHash(hash[:], "election-1", ciphertext, proof, previous); err != nil {
		t.Fatalf("valid ballot chain rejected: %v", err)
	}

	alteredPrevious := append([]byte(nil), previous...)
	alteredPrevious[0] ^= 1
	if err := VerifyBallotHash(hash[:], "election-1", ciphertext, proof, alteredPrevious); !errors.Is(err, ErrInvalidBallotHash) {
		t.Fatalf("altered previous hash error = %v, want ErrInvalidBallotHash", err)
	}
	if err := VerifyBallotHash(hash[:], "election-1", []byte("altered-ciphertext"), proof, previous); !errors.Is(err, ErrInvalidBallotHash) {
		t.Fatalf("altered ciphertext error = %v, want ErrInvalidBallotHash", err)
	}
	if err := VerifyBallotHash(hash[:], "election-1", ciphertext, []byte("altered-proof"), previous); !errors.Is(err, ErrInvalidBallotHash) {
		t.Fatalf("altered proof error = %v, want ErrInvalidBallotHash", err)
	}
}

func TestBallotHashValidation(t *testing.T) {
	if _, err := ComputeBallotHash("", []byte("ciphertext"), []byte("proof"), make([]byte, 32)); !errors.Is(err, ErrInvalidBallotHash) {
		t.Fatalf("empty election ID error = %v, want ErrInvalidBallotHash", err)
	}
	if _, err := ComputeBallotHash("election-1", nil, []byte("proof"), make([]byte, 32)); !errors.Is(err, ErrInvalidBallotHash) {
		t.Fatalf("empty ciphertext error = %v, want ErrInvalidBallotHash", err)
	}
	if _, err := ComputeBallotHash("election-1", []byte("ciphertext"), []byte("proof"), nil); !errors.Is(err, ErrInvalidBallotHash) {
		t.Fatalf("missing previous hash error = %v, want ErrInvalidBallotHash", err)
	}
}
