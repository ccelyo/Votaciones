package events

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/ccelyo/Votaciones/ballot/internal/election"
	"github.com/ccelyo/Votaciones/ballot/internal/pb"
)

func TestElectionCreatedRegistersTheUrn(t *testing.T) {
	store := election.NewMemoryStore()
	body := electionEvent(t, "election.created", fullElectionData(t))
	if err := ApplyElectionEvent(context.Background(), store, body); err != nil {
		t.Fatal(err)
	}
	if err := ApplyElectionEvent(context.Background(), store, body); err != nil {
		t.Fatal(err)
	}
	status, err := store.Status(context.Background(), "consejo-superior-2026", time.Date(2026, 10, 20, 14, 0, 0, 0, time.UTC))
	if err != nil || status != pb.ElectionStatus_ELECTION_STATUS_OPEN {
		t.Fatalf("status = %v, %v", status, err)
	}
}

func TestElectionCreatedWithoutKeysDoesNotOpenTheUrn(t *testing.T) {
	store := election.NewMemoryStore()
	body := electionEvent(t, "election.created", map[string]any{
		"election_id": "consejo-superior-2026",
		"options":     []string{"candidata-1"},
		"opens_at":    "2026-10-20T13:00:00Z",
		"closes_at":   "2026-10-20T21:00:00Z",
	})
	err := ApplyElectionEvent(context.Background(), store, body)
	if !errors.Is(err, ErrMetadataOnly) {
		t.Fatalf("err = %v", err)
	}
	status, err := store.Status(context.Background(), "consejo-superior-2026", time.Now())
	if err != nil || status != pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND {
		t.Fatalf("status = %v, %v", status, err)
	}
}

func TestElectionClosedRejectsFurtherBallots(t *testing.T) {
	store := election.NewMemoryStore()
	if err := ApplyElectionEvent(context.Background(), store, electionEvent(t, "election.created", fullElectionData(t))); err != nil {
		t.Fatal(err)
	}
	body := electionEvent(t, "election.closed", map[string]any{
		"election_id": "consejo-superior-2026",
		"closed_at":   "2026-10-20T21:00:00Z",
	})
	if err := ApplyElectionEvent(context.Background(), store, body); err != nil {
		t.Fatal(err)
	}
	if err := ApplyElectionEvent(context.Background(), store, body); err != nil {
		t.Fatal(err)
	}
	status, err := store.Status(context.Background(), "consejo-superior-2026", time.Date(2026, 10, 20, 18, 0, 0, 0, time.UTC))
	if err != nil || status != pb.ElectionStatus_ELECTION_STATUS_CLOSED {
		t.Fatalf("status = %v, %v", status, err)
	}
}

func TestElectionClosedForUnknownElectionIsPermanent(t *testing.T) {
	store := election.NewMemoryStore()
	err := ApplyElectionEvent(context.Background(), store, electionEvent(t, "election.closed", map[string]any{
		"election_id": "no-existe",
		"closed_at":   "2026-10-20T21:00:00Z",
	}))
	if !errors.Is(err, ErrElectionNotRegistered) || !permanentElectionError(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestMalformedElectionEventIsPermanent(t *testing.T) {
	store := election.NewMemoryStore()
	err := ApplyElectionEvent(context.Background(), store, []byte(`{"event_type":"election.created","data":{}}`))
	if !errors.Is(err, ErrPermanentEvent) || !permanentElectionError(err) {
		t.Fatalf("err = %v", err)
	}
}

func electionEvent(t *testing.T, eventType string, data any) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"event_id":       "11111111-1111-4111-8111-111111111111",
		"event_type":     eventType,
		"occurred_at":    "2026-10-20T12:00:00Z",
		"producer":       "election",
		"schema_version": 1,
		"data":           data,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func fullElectionData(t *testing.T) map[string]any {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{
		"election_id":           "consejo-superior-2026",
		"name":                  "Consejo Superior Universitario 2026",
		"options":               []string{"candidata-1", "voto-en-blanco"},
		"blank_option":          "voto-en-blanco",
		"opens_at":              "2026-10-20T13:00:00Z",
		"closes_at":             "2026-10-20T21:00:00Z",
		"encryption_public_key": base64.RawURLEncoding.EncodeToString([]byte("election-public-key")),
		"token_keys": []map[string]string{{
			"kid":               "key-1",
			"public_key_der":    base64.RawURLEncoding.EncodeToString(der),
			"signature_variant": "RSABSSA-SHA384-PSS-Randomized",
		}},
		"signed_parameters":             base64.RawURLEncoding.EncodeToString([]byte("signed-parameters")),
		"parameter_signing_key_id":      "params-1",
		"parameter_signature_algorithm": "Ed25519",
		"parameter_signature":           base64.RawURLEncoding.EncodeToString([]byte("signature")),
	}
}
