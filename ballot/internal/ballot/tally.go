package ballot

import "context"

// VoteReader returns the stored vote contents of one election. Implementations
// must return only the votes, never token IDs or chain positions, so a tally
// cannot be linked back to any receipt.
type VoteReader interface {
	Votes(ctx context.Context, electionID string) ([][]byte, error)
}

// OptionCount is the number of ballots cast for one option.
type OptionCount struct {
	Option string
	Votes  uint64
}

// Tally is the aggregate result of an election.
type Tally struct {
	Options []OptionCount
	Invalid uint64
	Total   uint64
}

// CountVotes aggregates votes by option, in the election's option order.
//
// Prototype 1 stores the chosen option as its UTF-8 text in encrypted_vote
// (no encryption yet); anything that is not exactly one of the options, such
// as ballots cast with the earlier stub ciphertext, is counted as invalid.
func CountVotes(options []string, votes [][]byte) Tally {
	tally := Tally{Options: make([]OptionCount, len(options)), Total: uint64(len(votes))}
	index := make(map[string]int, len(options))
	for i, option := range options {
		tally.Options[i].Option = option
		index[option] = i
	}
	for _, vote := range votes {
		if i, ok := index[string(vote)]; ok {
			tally.Options[i].Votes++
		} else {
			tally.Invalid++
		}
	}
	return tally
}
