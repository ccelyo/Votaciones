package ballot

import (
	"context"
	"errors"
)

// ErrInvalidProof means the validity proof does not match the encrypted ballot.
var ErrInvalidProof = errors.New("invalid ballot proof")

// StructuralProofVerifier only checks that a proof is present and bounded.
// It is the Prototype 1 placeholder until the encryption and validity-proof
// scheme is agreed with platform; it does not verify any cryptographic claim.
type StructuralProofVerifier struct{}

// Verify rejects empty or oversized proofs and accepts everything else.
func (StructuralProofVerifier) Verify(ctx context.Context, _ string, encryptedVote, proof []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(encryptedVote) == 0 || len(encryptedVote) > maxEncryptedBytes || len(proof) == 0 || len(proof) > maxProofBytes {
		return ErrInvalidProof
	}
	return nil
}
