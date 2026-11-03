// Package events publishes ballot facts to RabbitMQ.
//
// A votes.cast message carries only the election and the minute the ballot was
// accepted. It never includes the token, the receipt, the vote or any voter data,
// so analytics can count participation without linking a person to a ballot.
package events

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"time"
)

const (
	VotesExchange = "votes.events"
	VoteCastType  = "votes.cast"
	Producer      = "ballot"
)

// Envelope is the shared event wrapper (analytics/CONTRACTS.md §2).
type Envelope struct {
	EventID       string    `json:"event_id"`
	EventType     string    `json:"event_type"`
	OccurredAt    time.Time `json:"occurred_at"`
	Producer      string    `json:"producer"`
	SchemaVersion int       `json:"schema_version"`
	Data          VoteCast  `json:"data"`
}

// VoteCast is the votes.cast payload. CastAt is truncated to the minute.
type VoteCast struct {
	ElectionID string    `json:"election_id"`
	CastAt     time.Time `json:"cast_at"`
}

// TruncateMinute drops seconds so the event cannot be lined up with the
// moment identity issued the token.
func TruncateMinute(at time.Time) time.Time {
	at = at.UTC()
	return time.Date(at.Year(), at.Month(), at.Day(), at.Hour(), at.Minute(), 0, 0, time.UTC)
}

// NewVoteCast builds one votes.cast envelope.
func NewVoteCast(electionID string, at time.Time) (Envelope, error) {
	id, err := newEventID()
	if err != nil {
		return Envelope{}, err
	}
	at = at.UTC()
	return Envelope{
		EventID:       id,
		EventType:     VoteCastType,
		OccurredAt:    at,
		Producer:      Producer,
		SchemaVersion: 1,
		Data: VoteCast{
			ElectionID: electionID,
			CastAt:     TruncateMinute(at),
		},
	}, nil
}

// MarshalVoteCast returns the JSON body published to votes.events.
func MarshalVoteCast(electionID string, at time.Time) ([]byte, error) {
	envelope, err := NewVoteCast(electionID, at)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}
	return body, nil
}

func newEventID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("event id: %w", err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}
