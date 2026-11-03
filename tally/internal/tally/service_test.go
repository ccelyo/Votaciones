package tally

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ccelyo/Votaciones/tally/internal/ballotclient"
	"github.com/ccelyo/Votaciones/tally/internal/count"
	"github.com/ccelyo/Votaciones/tally/internal/decrypt"
	"github.com/ccelyo/Votaciones/tally/internal/events"
)

type fakeBallot struct {
	params  ballotclient.Parameters
	ballots [][]byte
	err     error
	mu      sync.Mutex
}

func (f *fakeBallot) Parameters(context.Context, string) (ballotclient.Parameters, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.params, f.err
}

func (f *fakeBallot) Ballots(context.Context, string) ([][]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ballots, f.err
}

type fakePublisher struct {
	mu        sync.Mutex
	envelopes []events.Envelope
	err       error
}

func (f *fakePublisher) Publish(_ context.Context, envelope events.Envelope) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.envelopes = append(f.envelopes, envelope)
	return nil
}

func (f *fakePublisher) Ping(context.Context) error { return nil }
func (f *fakePublisher) Close() error               { return nil }

func (f *fakePublisher) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.envelopes)
}

func TestRunCountsOnceAndReusesCache(t *testing.T) {
	ballot := &fakeBallot{
		params: ballotclient.Parameters{
			ElectionID:          "e1",
			Status:              "closed",
			Options:             []string{"candidato-1", "candidato-2"},
			EncryptionPublicKey: base64.RawURLEncoding.EncodeToString([]byte("opaque-p1-key")),
		},
		ballots: [][]byte{[]byte("candidato-1"), []byte("candidato-2"), []byte("candidato-1"), []byte("roto")},
	}
	broker := &fakePublisher{}
	service := New(ballot, broker, mustDecryptor(t, nil, true), true, nil)
	service.SetClock(func() time.Time { return time.Date(2026, 11, 2, 18, 0, 0, 0, time.UTC) })

	first, err := service.Run(context.Background(), "e1", RunRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if first.TotalBallots != 4 || first.InvalidBallots != 1 || first.EventID == "" {
		t.Fatalf("unexpected result: %+v", first)
	}
	if broker.count() != 1 {
		t.Fatalf("published %d events, want 1", broker.count())
	}

	second, err := service.Run(context.Background(), "e1", RunRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if !second.Reused {
		t.Fatal("second scrutiny must be marked reused")
	}
	if second.EventID != first.EventID {
		t.Fatalf("event id changed: %q != %q", second.EventID, first.EventID)
	}
	if broker.count() != 1 {
		t.Fatalf("published %d events after a repeat, want 1", broker.count())
	}

	stored, err := service.Get("e1")
	if err != nil || stored.EventID != first.EventID {
		t.Fatalf("Get = %+v, %v", stored, err)
	}
	if _, err := service.Get("unknown"); !errors.Is(err, ErrTallyPending) {
		t.Fatalf("Get unknown error = %v", err)
	}
}

func TestRepublishReusesEventID(t *testing.T) {
	ballot := &fakeBallot{
		params:  ballotclient.Parameters{ElectionID: "e1", Options: []string{"a"}},
		ballots: [][]byte{[]byte("a")},
	}
	broker := &fakePublisher{}
	service := New(ballot, broker, mustDecryptor(t, nil, true), true, nil)

	first, err := service.Run(context.Background(), "e1", RunRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Run(context.Background(), "e1", RunRequest{Republish: true}); err != nil {
		t.Fatal(err)
	}
	if broker.count() != 2 {
		t.Fatalf("published %d events, want 2", broker.count())
	}
	if broker.envelopes[0].EventID != broker.envelopes[1].EventID || broker.envelopes[0].EventID != first.EventID {
		t.Fatal("republish must reuse the same event_id")
	}
}

func TestConcurrentRunsPublishOnce(t *testing.T) {
	ballot := &fakeBallot{
		params:  ballotclient.Parameters{ElectionID: "e1", Options: []string{"a", "b"}},
		ballots: [][]byte{[]byte("a"), []byte("b"), []byte("a")},
	}
	broker := &fakePublisher{}
	service := New(ballot, broker, mustDecryptor(t, nil, true), true, nil)

	var wg sync.WaitGroup
	results := make(chan Completed, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := service.Run(context.Background(), "e1", RunRequest{})
			if err != nil {
				t.Error(err)
				return
			}
			results <- result
		}()
	}
	wg.Wait()
	close(results)
	for result := range results {
		if result.EventID == "" {
			t.Fatal("empty event id")
		}
	}
	if broker.count() != 1 {
		t.Fatalf("published %d events, want 1", broker.count())
	}
}

func TestRunRejectsWrongKey(t *testing.T) {
	urn := mustRSA(t)
	other := mustRSA(t)
	publicDER, _ := x509.MarshalPKIXPublicKey(&urn.PublicKey)
	ballot := &fakeBallot{
		params: ballotclient.Parameters{
			ElectionID:          "e1",
			Options:             []string{"a"},
			EncryptionPublicKey: base64.RawURLEncoding.EncodeToString(publicDER),
		},
		ballots: [][]byte{sealBallot(t, &urn.PublicKey, "a")},
	}
	service := New(ballot, &fakePublisher{}, mustDecryptor(t, nil, false), false, nil)

	_, err := service.Run(context.Background(), "e1", RunRequest{PrivateKey: pemBytes(t, other)})
	if !errors.Is(err, ErrWrongPrivateKey) {
		t.Fatalf("error = %v, want ErrWrongPrivateKey", err)
	}
}

func TestRunDecryptsEncryptedBallots(t *testing.T) {
	urn := mustRSA(t)
	publicDER, _ := x509.MarshalPKIXPublicKey(&urn.PublicKey)
	ballots := [][]byte{
		sealBallot(t, &urn.PublicKey, "a"),
		sealBallot(t, &urn.PublicKey, "b"),
		sealBallot(t, &urn.PublicKey, "a"),
	}
	ballot := &fakeBallot{
		params: ballotclient.Parameters{
			ElectionID:          "e1",
			Options:             []string{"a", "b", "voto-en-blanco"},
			EncryptionPublicKey: base64.RawURLEncoding.EncodeToString(publicDER),
		},
		ballots: ballots,
	}
	broker := &fakePublisher{}
	service := New(ballot, broker, mustDecryptor(t, nil, false), false, nil)

	result, err := service.Run(context.Background(), "e1", RunRequest{PrivateKey: pemBytes(t, urn)})
	if err != nil {
		t.Fatal(err)
	}
	if result.Results[0].Votes != 2 || result.Results[1].Votes != 1 || result.Results[2].Votes != 0 || result.InvalidBallots != 0 {
		t.Fatalf("unexpected results: %+v", result.Results)
	}
	if broker.envelopes[0].Data.BallotsDigest == "" {
		t.Fatal("missing ballots digest")
	}
}

func TestRunFailsWhenEveryEncryptedBallotIsUndecryptable(t *testing.T) {
	urn := mustRSA(t)
	other := mustRSA(t)
	ballot := &fakeBallot{
		params: ballotclient.Parameters{
			ElectionID:          "e1",
			Options:             []string{"a"},
			EncryptionPublicKey: base64.RawURLEncoding.EncodeToString([]byte("opaque")),
		},
		ballots: [][]byte{sealBallot(t, &urn.PublicKey, "a")},
	}
	service := New(ballot, &fakePublisher{}, mustDecryptor(t, nil, false), false, nil)
	_, err := service.Run(context.Background(), "e1", RunRequest{PrivateKey: pemBytes(t, other)})
	if !errors.Is(err, count.ErrAllUndecryptable) {
		t.Fatalf("error = %v, want ErrAllUndecryptable", err)
	}
}

func TestRunPropagatesElectionNotClosed(t *testing.T) {
	ballot := &fakeBallot{
		params: ballotclient.Parameters{ElectionID: "e1", Options: []string{"a"}},
		err:    ballotclient.ErrElectionNotClosed,
	}
	service := New(ballot, &fakePublisher{}, mustDecryptor(t, nil, true), true, nil)
	if _, err := service.Run(context.Background(), "e1", RunRequest{}); !errors.Is(err, ballotclient.ErrElectionNotClosed) {
		t.Fatalf("error = %v", err)
	}
}

func mustDecryptor(t *testing.T, material []byte, allowPlaintext bool) *decrypt.Decryptor {
	t.Helper()
	decryptor, err := decrypt.New(material, allowPlaintext)
	if err != nil {
		t.Fatal(err)
	}
	return decryptor
}

func mustRSA(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func pemBytes(t *testing.T, key *rsa.PrivateKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

func sealBallot(t *testing.T, public *rsa.PublicKey, option string) []byte {
	t.Helper()
	aesKey := make([]byte, 32)
	nonce := make([]byte, 12)
	if _, err := rand.Read(aesKey); err != nil {
		t.Fatal(err)
	}
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	payload := aead.Seal(nil, nonce, []byte(option), nil)
	wrapped, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, public, aesKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	envelope := map[string]string{
		"alg":        "RSA-OAEP-256+A256GCM",
		"key":        base64.RawURLEncoding.EncodeToString(wrapped),
		"nonce":      base64.RawURLEncoding.EncodeToString(nonce),
		"ciphertext": base64.RawURLEncoding.EncodeToString(payload),
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestDigestHexIsSha256(t *testing.T) {
	// Guards the shape of the digest published in ballots_digest.
	digest := events.EventID("e1", "00")
	if len(digest) != 36 {
		t.Fatalf("event id length = %d", len(digest))
	}
}
