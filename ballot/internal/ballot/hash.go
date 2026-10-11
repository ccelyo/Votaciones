// Package ballot contains privacy-preserving ballot digest helpers shared with M7.
package ballot

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"hash"
	"strings"
	"unicode"
	"unicode/utf8"
)

var ErrInvalidBallotHash = errors.New("invalid ballot hash or chain")

var ballotHashDomain = []byte("votaciones.ballot.encrypted-ballot.v1\x00")

const (
	maxElectionIDBytes = 128
	maxEncryptedBytes  = 1 << 20
	maxProofBytes      = 256 << 10
)

// ComputeBallotHash hashes the election, encrypted ballot, proof and previous hash.
// M7 should use this proposed encoding when constructing MongoDB ballot documents.
func ComputeBallotHash(electionID string, ciphertext, proof, previousHash []byte) ([sha256.Size]byte, error) {
	if !validElectionID(electionID) || len(ciphertext) == 0 || len(ciphertext) > maxEncryptedBytes ||
		len(proof) == 0 || len(proof) > maxProofBytes || len(previousHash) != sha256.Size {
		return [sha256.Size]byte{}, ErrInvalidBallotHash
	}
	digest := sha256.New()
	_, _ = digest.Write(ballotHashDomain)
	writeUint32(digest, uint32(len(electionID)))
	_, _ = digest.Write([]byte(electionID))
	writeBytes(digest, ciphertext)
	writeBytes(digest, proof)
	_, _ = digest.Write(previousHash)
	var result [sha256.Size]byte
	copy(result[:], digest.Sum(nil))
	return result, nil
}

// VerifyBallotHash compares the expected digest with a freshly computed chain hash.
func VerifyBallotHash(expected []byte, electionID string, ciphertext, proof, previousHash []byte) error {
	if len(expected) != sha256.Size {
		return ErrInvalidBallotHash
	}
	actual, err := ComputeBallotHash(electionID, ciphertext, proof, previousHash)
	if err != nil || subtle.ConstantTimeCompare(expected, actual[:]) != 1 {
		return ErrInvalidBallotHash
	}
	return nil
}

func writeUint32(digest hash.Hash, value uint32) {
	var encoded [4]byte
	binary.BigEndian.PutUint32(encoded[:], value)
	_, _ = digest.Write(encoded[:])
}

func writeBytes(digest hash.Hash, value []byte) {
	writeUint32(digest, uint32(len(value)))
	_, _ = digest.Write(value)
}

func validElectionID(value string) bool {
	if len(value) == 0 || len(value) > maxElectionIDBytes || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}
