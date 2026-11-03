package ballotclient

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestParametersAndBallots(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v1/elections/e1/parameters":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"election_id":"e1","status":"closed","options":["a","b"],"encryption_public_key":"` + base64.RawURLEncoding.EncodeToString([]byte("key")) + `"}`))
		case "/v1/elections/e1/ballots":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ballots":["` + base64.RawURLEncoding.EncodeToString([]byte("vote-a")) + `","` + base64.RawURLEncoding.EncodeToString([]byte("vote-b")) + `"]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := New(server.URL, "secret", 2*time.Second)
	params, err := client.Parameters(context.Background(), "e1")
	if err != nil {
		t.Fatal(err)
	}
	if len(params.Options) != 2 || params.ElectionID != "e1" {
		t.Fatalf("unexpected parameters: %+v", params)
	}
	publicKey, err := params.PublicKeyDER()
	if err != nil || string(publicKey) != "key" {
		t.Fatalf("public key = %q, %v", publicKey, err)
	}
	ballots, err := client.Ballots(context.Background(), "e1")
	if err != nil {
		t.Fatal(err)
	}
	if len(ballots) != 2 || string(ballots[0]) != "vote-a" || string(ballots[1]) != "vote-b" {
		t.Fatalf("unexpected ballots: %q", ballots)
	}
}

func TestMapsClosedNotFoundAndUnauthorized(t *testing.T) {
	for name, status := range map[string]int{
		"not-found":    http.StatusNotFound,
		"not-closed":   http.StatusConflict,
		"unauthorized": http.StatusUnauthorized,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))
		client := New(server.URL, "", time.Second)
		_, err := client.Ballots(context.Background(), "e1")
		server.Close()

		switch status {
		case http.StatusNotFound:
			if !errors.Is(err, ErrElectionNotFound) {
				t.Fatalf("%s: %v", name, err)
			}
		case http.StatusConflict:
			if !errors.Is(err, ErrElectionNotClosed) {
				t.Fatalf("%s: %v", name, err)
			}
		case http.StatusUnauthorized:
			if !errors.Is(err, ErrUnavailable) {
				t.Fatalf("%s: %v", name, err)
			}
		}
	}
}

func TestRetriesTransientServerErrors(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Write([]byte(`{"ballots":[]}`))
	}))
	defer server.Close()

	client := New(server.URL, "", 2*time.Second)
	if _, err := client.Ballots(context.Background(), "e1"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2", calls.Load())
	}
}

func TestNetworkFailureIsUnavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := server.URL
	server.Close()

	client := New(address, "", time.Second)
	_, err := client.Ballots(context.Background(), "e1")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("error = %v, want ErrUnavailable", err)
	}
}

func TestRejectsUnsafeElectionID(t *testing.T) {
	client := New("http://example.invalid", "", time.Second)
	for _, electionID := range []string{"", "a/b", "a?b", "a#b"} {
		if _, err := client.Ballots(context.Background(), electionID); err == nil {
			t.Fatalf("election id %q was accepted", electionID)
		}
	}
}
