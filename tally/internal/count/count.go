// Package count applies the counting rules to decrypted ballots.
package count

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"sort"
	"strings"

	"github.com/ccelyo/Votaciones/tally/internal/decrypt"
)

var (
	// ErrAllUndecryptable means every ballot failed to decrypt. It usually points
	// to a wrong urn key, so the tally is aborted instead of publishing zero votes.
	ErrAllUndecryptable = errors.New("all ballots failed to decrypt; check the urn private key")
	// ErrInvalidOptions means Ballot published an ambiguous option list.
	ErrInvalidOptions = errors.New("invalid election options")
)

// OptionCount is the number of valid ballots for one option.
type OptionCount struct {
	Option string `json:"option"`
	Votes  uint64 `json:"votes"`
}

// Result is the official count of one election.
type Result struct {
	ElectionID     string
	TotalBallots   uint64
	InvalidBallots uint64
	Results        []OptionCount
}

// DecryptFunc returns the option encoded in a ballot.
type DecryptFunc func([]byte) (string, error)

// ValidateOptions rejects ambiguous option lists: empty, duplicated or
// whitespace-padded options would make the comparison depend on accident.
func ValidateOptions(options []string) error {
	if len(options) == 0 {
		return fmt.Errorf("%w: election has no options", ErrInvalidOptions)
	}
	seen := make(map[string]struct{}, len(options))
	for _, option := range options {
		if option == "" || strings.TrimSpace(option) != option {
			return fmt.Errorf("%w: invalid option %q", ErrInvalidOptions, option)
		}
		if _, exists := seen[option]; exists {
			return fmt.Errorf("%w: duplicated option %q", ErrInvalidOptions, option)
		}
		seen[option] = struct{}{}
	}
	return nil
}

// Count aggregates ballots. Every ballot whose decrypted content is not
// exactly one of the options is invalid; a decryption error never aborts the
// count unless it affects every ballot.
func Count(electionID string, options []string, ballots [][]byte, decryptBallot DecryptFunc) (Result, error) {
	if err := ValidateOptions(options); err != nil {
		return Result{}, err
	}
	if decryptBallot == nil {
		return Result{}, errors.New("decrypt function is required")
	}
	index := make(map[string]int, len(options))
	result := Result{ElectionID: electionID, TotalBallots: uint64(len(ballots)), Results: make([]OptionCount, len(options))}
	for i, option := range options {
		result.Results[i].Option = option
		index[option] = i
	}

	var undecryptable uint64
	for _, ballot := range ballots {
		option, err := decryptBallot(ballot)
		if err != nil {
			if errors.Is(err, decrypt.ErrPrivateKeyRequired) {
				return Result{}, err
			}
			undecryptable++
			result.InvalidBallots++
			continue
		}
		i, ok := index[option]
		if !ok {
			result.InvalidBallots++
			continue
		}
		result.Results[i].Votes++
	}
	if undecryptable > 0 && undecryptable == result.TotalBallots {
		return Result{}, ErrAllUndecryptable
	}
	if err := result.Validate(); err != nil {
		return Result{}, err
	}
	return result, nil
}

// Validate checks the invariant analytics enforces on tally.completed.
func (r Result) Validate() error {
	var valid uint64
	for _, option := range r.Results {
		valid += option.Votes
	}
	if valid+r.InvalidBallots != r.TotalBallots {
		return fmt.Errorf("inconsistent tally: %d valid + %d invalid != %d total", valid, r.InvalidBallots, r.TotalBallots)
	}
	return nil
}

// Digest returns a stable fingerprint of the urn. It covers the option list and
// the sorted ciphertexts because Ballot's Mongo query has no explicit order:
// running the scrutiny twice over the same closed urn yields the same digest
// (and therefore the same event_id) regardless of storage order or a restart.
func Digest(electionID string, options []string, ballots [][]byte) string {
	sortedBallots := make([][]byte, len(ballots))
	copy(sortedBallots, ballots)
	sort.Slice(sortedBallots, func(i, j int) bool {
		return compareBytes(sortedBallots[i], sortedBallots[j]) < 0
	})
	h := sha256.New()
	writeField(h, []byte("tally.urn.v2"))
	writeField(h, []byte(electionID))
	writeUint(h, uint64(len(options)))
	for _, option := range options {
		writeField(h, []byte(option))
	}
	writeUint(h, uint64(len(sortedBallots)))
	for _, ballot := range sortedBallots {
		writeField(h, ballot)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func writeField(h hash.Hash, value []byte) {
	writeUint(h, uint64(len(value)))
	h.Write(value)
}

func writeUint(h hash.Hash, value uint64) {
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], value)
	h.Write(length[:])
}

func compareBytes(a, b []byte) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	default:
		return 0
	}
}
