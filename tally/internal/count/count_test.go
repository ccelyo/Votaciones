package count

import (
	"errors"
	"testing"

	"github.com/ccelyo/Votaciones/tally/internal/decrypt"
)

func plaintextBallot(ballot []byte) (string, error) {
	return string(ballot), nil
}

func TestCountValidInvalidAndBlank(t *testing.T) {
	options := []string{"candidato-1", "candidato-2", "voto-en-blanco"}
	ballots := [][]byte{
		[]byte("candidato-1"),
		[]byte("candidato-2"),
		[]byte("candidato-1"),
		[]byte("voto-en-blanco"),
		[]byte("no-existe"),
		[]byte(""),
	}
	result, err := Count("e1", options, ballots, plaintextBallot)
	if err != nil {
		t.Fatal(err)
	}
	if result.TotalBallots != 6 || result.InvalidBallots != 2 {
		t.Fatalf("unexpected totals: %+v", result)
	}
	want := []OptionCount{
		{Option: "candidato-1", Votes: 2},
		{Option: "candidato-2", Votes: 1},
		{Option: "voto-en-blanco", Votes: 1},
	}
	for i := range want {
		if result.Results[i] != want[i] {
			t.Fatalf("result %d = %+v, want %+v", i, result.Results[i], want[i])
		}
	}
}

func TestCountRejectsAmbiguousOptions(t *testing.T) {
	for name, options := range map[string][]string{
		"empty":      nil,
		"blank":      {"a", ""},
		"duplicated": {"a", "a"},
		"padded":     {"a "},
	} {
		if _, err := Count("e1", options, nil, plaintextBallot); !errors.Is(err, ErrInvalidOptions) {
			t.Fatalf("%s: error = %v, want ErrInvalidOptions", name, err)
		}
	}
}

func TestCountAllUndecryptableAborts(t *testing.T) {
	options := []string{"a"}
	failing := func([]byte) (string, error) { return "", decrypt.ErrUndecryptable }
	if _, err := Count("e1", options, [][]byte{[]byte("x"), []byte("y")}, failing); !errors.Is(err, ErrAllUndecryptable) {
		t.Fatalf("error = %v, want ErrAllUndecryptable", err)
	}
}

func TestCountMissingKeyIsNotInvalid(t *testing.T) {
	options := []string{"a"}
	needsKey := func([]byte) (string, error) { return "", decrypt.ErrPrivateKeyRequired }
	if _, err := Count("e1", options, [][]byte{[]byte("x")}, needsKey); !errors.Is(err, decrypt.ErrPrivateKeyRequired) {
		t.Fatalf("error = %v, want ErrPrivateKeyRequired", err)
	}
}

func TestDigestIgnoresBallotOrder(t *testing.T) {
	options := []string{"a", "b", "c"}
	a := [][]byte{[]byte("one"), []byte("two"), []byte("three")}
	b := [][]byte{[]byte("three"), []byte("one"), []byte("two")}
	if Digest("e1", options, a) != Digest("e1", options, b) {
		t.Fatal("digest must not depend on storage order")
	}
	if Digest("e1", options, a) == Digest("e2", options, a) {
		t.Fatal("digest must depend on the election")
	}
	if Digest("e1", options, a) == Digest("e1", options, b[:2]) {
		t.Fatal("different ballot sets must have different digests")
	}
	if Digest("e1", options, a) == Digest("e1", []string{"a", "b", "d"}, a) {
		t.Fatal("changing the options must change the digest")
	}
}

func TestDigestDoesNotMutateInput(t *testing.T) {
	ballots := [][]byte{[]byte("b"), []byte("a")}
	Digest("e1", []string{"a", "b"}, ballots)
	if string(ballots[0]) != "b" || string(ballots[1]) != "a" {
		t.Fatalf("input order changed: %q", ballots)
	}
}
