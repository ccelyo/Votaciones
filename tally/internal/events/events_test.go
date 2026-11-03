package events

import (
	"encoding/json"
	"regexp"
	"testing"
	"time"
)

func TestEventIDIsStableAndVersion5(t *testing.T) {
	first := EventID("e1", "digest-a")
	second := EventID("e1", "digest-a")
	if first != second {
		t.Fatalf("event id is not deterministic: %q != %q", first, second)
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(first) {
		t.Fatalf("event id is not a UUIDv5: %q", first)
	}
	if first == EventID("e1", "digest-b") {
		t.Fatal("a different urn must produce a different event id")
	}
	if first == EventID("e2", "digest-a") {
		t.Fatal("a different election must produce a different event id")
	}
}

func TestEnvelopeJSONMatchesContract(t *testing.T) {
	at := time.Date(2026, 11, 2, 18, 0, 0, 0, time.UTC)
	envelope := NewCompleted("e1", "abc", 4, 1, []OptionVotes{{Option: "a", Votes: 2}, {Option: "b", Votes: 1}}, at)
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["event_type"] != TypeTallyCompleted || decoded["producer"] != Producer {
		t.Fatalf("unexpected envelope: %s", body)
	}
	if decoded["schema_version"].(float64) != SchemaVersion {
		t.Fatalf("unexpected schema version: %s", body)
	}
	data := decoded["data"].(map[string]any)
	if data["ballots_digest"] != "abc" || data["total_ballots"].(float64) != 4 {
		t.Fatalf("unexpected payload: %s", body)
	}
	if envelope.EventID != EventID("e1", "abc") {
		t.Fatalf("event id = %q", envelope.EventID)
	}
}
