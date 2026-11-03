package events

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/ccelyo/Votaciones/ballot/internal/election"
)

const (
	ElectionExchange = "election.events"
	ElectionQueue    = "ballot.elections"
	electionCreated  = "election.created"
	electionClosed   = "election.closed"
)

var (
	// ErrMetadataOnly means the event matches the analytics contract but does not
	// carry the urn parameters ballot needs to accept ballots.
	ErrMetadataOnly = errors.New("election event has no urn parameters")
	// ErrElectionNotRegistered means a close arrived for an election ballot does not know.
	ErrElectionNotRegistered = errors.New("election is not registered")
	// ErrPermanentEvent means the payload will not become valid by retrying.
	ErrPermanentEvent = errors.New("election event rejected")
)

type electionEnvelope struct {
	EventType     string          `json:"event_type"`
	SchemaVersion *int            `json:"schema_version"`
	Data          json.RawMessage `json:"data"`
}

type tokenKeyWire struct {
	KID              string `json:"kid"`
	PublicKeyDER     string `json:"public_key_der"`
	SignatureVariant string `json:"signature_variant"`
}

type electionCreatedData struct {
	ElectionID                  string         `json:"election_id"`
	Options                     []string       `json:"options"`
	OpensAt                     time.Time      `json:"opens_at"`
	ClosesAt                    time.Time      `json:"closes_at"`
	EncryptionPublicKey         string         `json:"encryption_public_key"`
	TokenKeys                   []tokenKeyWire `json:"token_keys"`
	SignedParameters            string         `json:"signed_parameters"`
	ParameterSigningKeyID       string         `json:"parameter_signing_key_id"`
	ParameterSignatureAlgorithm string         `json:"parameter_signature_algorithm"`
	ParameterSignature          string         `json:"parameter_signature"`
}

type electionClosedData struct {
	ElectionID string    `json:"election_id"`
	ClosedAt   time.Time `json:"closed_at"`
}

// ApplyElectionEvent registers or closes an election from one election.events message.
// A repeated event is safe: Register and Close are idempotent.
func ApplyElectionEvent(ctx context.Context, store election.Store, body []byte) error {
	if store == nil {
		return fmt.Errorf("%w: store is missing", ErrPermanentEvent)
	}
	var envelope electionEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil || len(envelope.Data) == 0 || envelope.EventType == "" {
		return fmt.Errorf("%w: malformed envelope", ErrPermanentEvent)
	}
	version := 1
	if envelope.SchemaVersion != nil {
		version = *envelope.SchemaVersion
	}
	if version != 1 {
		return fmt.Errorf("%w: schema_version %d", ErrPermanentEvent, version)
	}
	switch envelope.EventType {
	case electionCreated:
		return applyCreated(ctx, store, envelope.Data)
	case electionClosed:
		return applyClosed(ctx, store, envelope.Data)
	default:
		return fmt.Errorf("%w: event_type %s", ErrPermanentEvent, envelope.EventType)
	}
}

func applyCreated(ctx context.Context, store election.Store, data json.RawMessage) error {
	var payload electionCreatedData
	if err := json.Unmarshal(data, &payload); err != nil || payload.ElectionID == "" {
		return fmt.Errorf("%w: malformed election.created", ErrPermanentEvent)
	}
	if !hasUrnParameters(payload) {
		return fmt.Errorf("%w: %s", ErrMetadataOnly, payload.ElectionID)
	}
	config, err := electionFromEvent(payload)
	if err != nil {
		return err
	}
	if _, err := store.Register(ctx, config); err != nil {
		if errors.Is(err, election.ErrRegistrationConflict) || errors.Is(err, election.ErrInvalidElection) {
			return fmt.Errorf("%w: %s", ErrPermanentEvent, err.Error())
		}
		return err
	}
	return nil
}

func applyClosed(ctx context.Context, store election.Store, data json.RawMessage) error {
	var payload electionClosedData
	if err := json.Unmarshal(data, &payload); err != nil || payload.ElectionID == "" || payload.ClosedAt.IsZero() {
		return fmt.Errorf("%w: malformed election.closed", ErrPermanentEvent)
	}
	if _, err := store.Close(ctx, payload.ElectionID, payload.ClosedAt.UTC()); err != nil {
		if errors.Is(err, election.ErrElectionNotFound) {
			return fmt.Errorf("%w: %s", ErrElectionNotRegistered, payload.ElectionID)
		}
		return err
	}
	return nil
}

func hasUrnParameters(payload electionCreatedData) bool {
	return payload.EncryptionPublicKey != "" || len(payload.TokenKeys) > 0 || payload.SignedParameters != ""
}

func electionFromEvent(payload electionCreatedData) (election.Election, error) {
	encryptionKey, err := decodeParameter(payload.EncryptionPublicKey)
	if err != nil || len(payload.Options) == 0 || !payload.ClosesAt.After(payload.OpensAt) ||
		payload.ParameterSigningKeyID == "" || payload.ParameterSignatureAlgorithm == "" {
		return election.Election{}, fmt.Errorf("%w: incomplete election.created", ErrPermanentEvent)
	}
	signedParameters, err := decodeParameter(payload.SignedParameters)
	if err != nil {
		return election.Election{}, fmt.Errorf("%w: signed_parameters", ErrPermanentEvent)
	}
	signature, err := decodeParameter(payload.ParameterSignature)
	if err != nil {
		return election.Election{}, fmt.Errorf("%w: parameter_signature", ErrPermanentEvent)
	}
	keys := make([]election.TokenKey, 0, len(payload.TokenKeys))
	for _, key := range payload.TokenKeys {
		der, err := decodeParameter(key.PublicKeyDER)
		if err != nil || key.KID == "" || key.SignatureVariant == "" {
			return election.Election{}, fmt.Errorf("%w: token key", ErrPermanentEvent)
		}
		parsed, err := x509.ParsePKIXPublicKey(der)
		if err != nil {
			return election.Election{}, fmt.Errorf("%w: token key is not a public key", ErrPermanentEvent)
		}
		if _, ok := parsed.(*rsa.PublicKey); !ok {
			return election.Election{}, fmt.Errorf("%w: token key is not RSA", ErrPermanentEvent)
		}
		keys = append(keys, election.TokenKey{KID: key.KID, PublicKeyDER: der, SignatureVariant: key.SignatureVariant})
	}
	config := election.Election{
		ID:                  payload.ElectionID,
		Options:             payload.Options,
		EncryptionPublicKey: encryptionKey,
		TokenKeys:           keys,
		OpensAt:             payload.OpensAt.UTC(),
		ClosesAt:            payload.ClosesAt.UTC(),
		SignedParameters:    signedParameters,
		SigningKeyID:        payload.ParameterSigningKeyID,
		SignatureAlgorithm:  payload.ParameterSignatureAlgorithm,
		ParameterSignature:  signature,
	}
	if !election.ValidRegistration(config) {
		return election.Election{}, fmt.Errorf("%w: election cannot accept ballots", ErrPermanentEvent)
	}
	return config, nil
}

func decodeParameter(value string) ([]byte, error) {
	if value == "" {
		return nil, errors.New("empty")
	}
	return base64.RawURLEncoding.Strict().DecodeString(value)
}
