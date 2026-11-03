// Package events defines the tally.completed contract shared with Analytics
// and Notifications. See docs/events.md for the full RabbitMQ topology.
package events

import (
	"crypto/sha1"
	"encoding/hex"
	"time"
)

const (
	// TypeTallyCompleted is both the event_type and the routing key.
	TypeTallyCompleted = "tally.completed"
	// Producer identifies this service in the envelope.
	Producer = "tally"
	// SchemaVersion is the only version consumers accept today.
	SchemaVersion = 1
)

// Envelope is the JSON message published to RabbitMQ. The routing key always
// equals EventType.
type Envelope struct {
	EventID       string    `json:"event_id"`
	EventType     string    `json:"event_type"`
	OccurredAt    time.Time `json:"occurred_at"`
	Producer      string    `json:"producer"`
	SchemaVersion uint32    `json:"schema_version"`
	Data          Payload   `json:"data"`
}

// Payload is the official result of one election.
type Payload struct {
	ElectionID     string        `json:"election_id"`
	TotalBallots   uint64        `json:"total_ballots"`
	InvalidBallots uint64        `json:"invalid_ballots"`
	Results        []OptionVotes `json:"results"`
	TalliedAt      time.Time     `json:"tallied_at"`
	// BallotsDigest is a SHA-256 fingerprint of the sorted ciphertexts. It
	// lets an auditor prove that a recount used the same urn; it reveals
	// nothing about individual ballots.
	BallotsDigest string `json:"ballots_digest"`
}

// OptionVotes is the count for one option. Blank votes are a normal option and
// therefore appear here, exactly as in Ballot's results endpoint.
type OptionVotes struct {
	Option string `json:"option"`
	Votes  uint64 `json:"votes"`
}

// NewCompleted builds the envelope. occurredAt and talliedAt are the same
// instant: the tally finished when the event was produced.
func NewCompleted(electionID, ballotsDigest string, total, invalid uint64, results []OptionVotes, talliedAt time.Time) Envelope {
	talliedAt = talliedAt.UTC()
	return Envelope{
		EventID:       EventID(electionID, ballotsDigest),
		EventType:     TypeTallyCompleted,
		OccurredAt:    talliedAt,
		Producer:      Producer,
		SchemaVersion: SchemaVersion,
		Data: Payload{
			ElectionID:     electionID,
			TotalBallots:   total,
			InvalidBallots: invalid,
			Results:        results,
			TalliedAt:      talliedAt,
			BallotsDigest:  ballotsDigest,
		},
	}
}

// EventID is a deterministic RFC 4122 UUIDv5 derived from the election and the
// ballot digest. Re-running the scrutiny over the same urn reuses the same
// event_id, so Analytics discards the duplicate instead of counting twice.
func EventID(electionID, ballotsDigest string) string {
	name := TypeTallyCompleted + "|v1|" + electionID + "|" + ballotsDigest
	h := sha1.New()
	h.Write(namespace[:])
	h.Write([]byte(name))
	sum := h.Sum(nil)
	var uuid [16]byte
	copy(uuid[:], sum[:16])
	uuid[6] = (uuid[6] & 0x0f) | 0x50 // version 5
	uuid[8] = (uuid[8] & 0x3f) | 0x80 // RFC 4122 variant
	return formatUUID(uuid)
}

// namespace is a fixed UUID for Tally's deterministic event identifiers.
// Changing it changes every event_id, so it must stay stable.
var namespace = [16]byte{
	0x6e, 0x2c, 0x1b, 0x4a, 0x9f, 0x37, 0x5d, 0x0e,
	0xa3, 0x61, 0x2b, 0x8c, 0x45, 0x19, 0xf0, 0x77,
}

func formatUUID(uuid [16]byte) string {
	var buf [36]byte
	hex.Encode(buf[0:8], uuid[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], uuid[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], uuid[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], uuid[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], uuid[10:16])
	return string(buf[:])
}
