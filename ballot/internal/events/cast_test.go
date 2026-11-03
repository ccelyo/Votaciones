package events

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestVoteCastTruncatesToTheMinuteAndOmitsTheBallot(t *testing.T) {
	at := time.Date(2026, 10, 20, 15, 42, 37, 999, time.UTC)
	body, err := MarshalVoteCast("consejo-superior-2026", at)
	if err != nil {
		t.Fatal(err)
	}
	var envelope Envelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.EventType != VoteCastType || envelope.Producer != Producer || envelope.SchemaVersion != 1 {
		t.Fatalf("envelope = %+v", envelope)
	}
	if envelope.Data.ElectionID != "consejo-superior-2026" {
		t.Fatalf("election = %s", envelope.Data.ElectionID)
	}
	if !envelope.Data.CastAt.Equal(time.Date(2026, 10, 20, 15, 42, 0, 0, time.UTC)) {
		t.Fatalf("cast_at = %s", envelope.Data.CastAt)
	}
	text := string(body)
	for _, forbidden := range []string{"token", "receipt", "ciphertext", "user", "proof", "seq"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("event contains %q: %s", forbidden, text)
		}
	}
}

func TestTruncateMinute(t *testing.T) {
	got := TruncateMinute(time.Date(2026, 1, 2, 3, 4, 59, 0, time.FixedZone("COT", -5*3600)))
	want := time.Date(2026, 1, 2, 8, 4, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("truncated = %s, want %s", got, want)
	}
}
