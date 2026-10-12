package mongostore

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"reflect"
	"time"

	"github.com/ccelyo/Votaciones/ballot/internal/election"
	"github.com/ccelyo/Votaciones/ballot/internal/pb"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const maxKeyUpdateAttempts = 4

// electionDocument stores an election's public configuration, lifecycle and
// chain head. Keeping the head here makes every ballot commit write this
// document, so a concurrent Close and commit always conflict instead of
// letting a ballot slip in after closure.
type electionDocument struct {
	ID                 string             `bson:"_id"`
	Options            []string           `bson:"options"`
	EncryptionKey      []byte             `bson:"encryption_public_key"`
	TokenKeys          []tokenKeyDocument `bson:"token_keys"`
	OpensAt            time.Time          `bson:"opens_at"`
	ClosesAt           time.Time          `bson:"closes_at"`
	SignedParameters   []byte             `bson:"signed_parameters"`
	SigningKeyID       string             `bson:"parameter_signing_key_id"`
	SignatureAlgorithm string             `bson:"parameter_signature_algorithm"`
	ParameterSignature []byte             `bson:"parameter_signature"`
	Closed             bool               `bson:"closed"`
	Seq                int64              `bson:"seq"`
	HeadHash           []byte             `bson:"head_hash"`
}

type tokenKeyDocument struct {
	KID              string `bson:"kid"`
	PublicKeyDER     []byte `bson:"public_key_der"`
	SignatureVariant string `bson:"signature_variant"`
}

func (d electionDocument) acceptsBallots(now time.Time) bool {
	return !d.Closed && !now.Before(d.OpensAt) && now.Before(d.ClosesAt)
}

func (d electionDocument) election() election.Election {
	keys := make([]election.TokenKey, 0, len(d.TokenKeys))
	for _, key := range d.TokenKeys {
		keys = append(keys, election.TokenKey{KID: key.KID, PublicKeyDER: key.PublicKeyDER, SignatureVariant: key.SignatureVariant})
	}
	return election.Election{
		ID:                  d.ID,
		Options:             d.Options,
		EncryptionPublicKey: d.EncryptionKey,
		TokenKeys:           keys,
		OpensAt:             d.OpensAt.UTC(),
		ClosesAt:            d.ClosesAt.UTC(),
		SignedParameters:    d.SignedParameters,
		SigningKeyID:        d.SigningKeyID,
		SignatureAlgorithm:  d.SignatureAlgorithm,
		ParameterSignature:  d.ParameterSignature,
	}
}

func newElectionDocument(config election.Election) electionDocument {
	keys := make([]tokenKeyDocument, 0, len(config.TokenKeys))
	for _, key := range config.TokenKeys {
		keys = append(keys, tokenKeyDocument{KID: key.KID, PublicKeyDER: key.PublicKeyDER, SignatureVariant: key.SignatureVariant})
	}
	return electionDocument{
		ID:                 config.ID,
		Options:            config.Options,
		EncryptionKey:      config.EncryptionPublicKey,
		TokenKeys:          keys,
		OpensAt:            config.OpensAt.UTC(),
		ClosesAt:           config.ClosesAt.UTC(),
		SignedParameters:   config.SignedParameters,
		SigningKeyID:       config.SigningKeyID,
		SignatureAlgorithm: config.SignatureAlgorithm,
		ParameterSignature: config.ParameterSignature,
		HeadHash:           make([]byte, 32),
	}
}

func (s *Store) findElection(ctx context.Context, electionID string) (electionDocument, bool, error) {
	var document electionDocument
	err := s.elections.FindOne(ctx, bson.D{{Key: "_id", Value: electionID}}).Decode(&document)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return electionDocument{}, false, nil
	}
	if err != nil {
		return electionDocument{}, false, err
	}
	return document, true, nil
}

// Register idempotently stores an election's public parameters and verification keys.
func (s *Store) Register(ctx context.Context, config election.Election) (bool, error) {
	if !election.ValidRegistration(config) {
		return false, election.ErrInvalidElection
	}
	_, err := s.elections.InsertOne(ctx, newElectionDocument(config))
	if err == nil {
		return true, nil
	}
	if !mongo.IsDuplicateKeyError(err) {
		return false, err
	}
	existing, found, err := s.findElection(ctx, config.ID)
	if err != nil {
		return false, err
	}
	if found && election.SameRegistration(existing.election(), config) {
		return false, nil
	}
	return false, election.ErrRegistrationConflict
}

// AddTokenVerificationKey adds a key ID without replacing older keys. The update
// is conditioned on the key ID being absent and the election still open.
func (s *Store) AddTokenVerificationKey(ctx context.Context, electionID string, key election.TokenKey) (bool, error) {
	if electionID == "" || !election.ValidTokenKey(key) {
		return false, election.ErrInvalidElection
	}
	for attempt := 0; attempt < maxKeyUpdateAttempts; attempt++ {
		document, found, err := s.findElection(ctx, electionID)
		if err != nil {
			return false, err
		}
		if !found {
			return false, election.ErrElectionNotFound
		}
		if document.Closed || !s.now().UTC().Before(document.ClosesAt) {
			return false, token.ErrElectionClosed
		}
		for _, existing := range document.TokenKeys {
			if existing.KID != key.KID {
				continue
			}
			if reflect.DeepEqual(existing, tokenKeyDocument{KID: key.KID, PublicKeyDER: key.PublicKeyDER, SignatureVariant: key.SignatureVariant}) {
				return false, nil
			}
			return false, election.ErrTokenKeyConflict
		}
		result, err := s.elections.UpdateOne(ctx,
			bson.D{{Key: "_id", Value: electionID}, {Key: "closed", Value: false}, {Key: "token_keys.kid", Value: bson.D{{Key: "$ne", Value: key.KID}}}},
			bson.D{{Key: "$push", Value: bson.D{{Key: "token_keys", Value: bson.D{
				{Key: "$each", Value: bson.A{tokenKeyDocument{KID: key.KID, PublicKeyDER: key.PublicKeyDER, SignatureVariant: key.SignatureVariant}}},
				{Key: "$sort", Value: bson.D{{Key: "kid", Value: 1}}},
			}}}}},
		)
		if err != nil {
			return false, err
		}
		if result.ModifiedCount == 1 {
			return true, nil
		}
		// Closed or the same kid was added concurrently; re-evaluate.
	}
	return false, errors.New("token key update contention exceeded retry budget")
}

// Close irreversibly closes an election. Repeated close requests are idempotent.
func (s *Store) Close(ctx context.Context, electionID string, _ time.Time) (pb.ElectionStatus, error) {
	result, err := s.elections.UpdateOne(ctx,
		bson.D{{Key: "_id", Value: electionID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "closed", Value: true}}}},
	)
	if err != nil {
		return pb.ElectionStatus_ELECTION_STATUS_UNSPECIFIED, err
	}
	if result.MatchedCount == 0 {
		return pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND, election.ErrElectionNotFound
	}
	return pb.ElectionStatus_ELECTION_STATUS_CLOSED, nil
}

// Status reports only whether an election accepts ballots, is closed, or is absent.
func (s *Store) Status(ctx context.Context, electionID string, now time.Time) (pb.ElectionStatus, error) {
	document, found, err := s.findElection(ctx, electionID)
	if err != nil {
		return pb.ElectionStatus_ELECTION_STATUS_UNSPECIFIED, err
	}
	if !found {
		return pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND, nil
	}
	if document.acceptsBallots(now) {
		return pb.ElectionStatus_ELECTION_STATUS_OPEN, nil
	}
	return pb.ElectionStatus_ELECTION_STATUS_CLOSED, nil
}

// Count returns participation from the chain length; it never reads vote contents.
func (s *Store) Count(ctx context.Context, electionID string) (uint64, error) {
	document, found, err := s.findElection(ctx, electionID)
	if err != nil {
		return 0, err
	}
	if !found {
		return 0, election.ErrElectionNotFound
	}
	return uint64(document.Seq), nil
}

// Parameters returns an election's public configuration.
func (s *Store) Parameters(ctx context.Context, electionID string) (election.Election, error) {
	document, found, err := s.findElection(ctx, electionID)
	if err != nil {
		return election.Election{}, err
	}
	if !found {
		return election.Election{}, election.ErrElectionNotFound
	}
	return document.election(), nil
}

// ResolveTokenKey implements token.KeyResolver for registered election keys.
func (s *Store) ResolveTokenKey(ctx context.Context, electionID, kid string) (token.VerificationKey, bool, error) {
	var document electionDocument
	err := s.elections.FindOne(ctx,
		bson.D{{Key: "_id", Value: electionID}},
		options.FindOne().SetProjection(bson.D{{Key: "token_keys", Value: 1}}),
	).Decode(&document)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return token.VerificationKey{}, false, nil
	}
	if err != nil {
		return token.VerificationKey{}, false, err
	}
	for _, key := range document.TokenKeys {
		if key.KID != kid {
			continue
		}
		parsed, err := x509.ParsePKIXPublicKey(key.PublicKeyDER)
		if err != nil {
			return token.VerificationKey{}, false, err
		}
		publicKey, ok := parsed.(*rsa.PublicKey)
		if !ok {
			return token.VerificationKey{}, false, election.ErrInvalidElection
		}
		return token.VerificationKey{PublicKey: publicKey, Variant: key.SignatureVariant}, true, nil
	}
	return token.VerificationKey{}, false, nil
}

// ElectionState implements token.ElectionStateReader using the store's clock.
func (s *Store) ElectionState(ctx context.Context, electionID string) (bool, bool, error) {
	status, err := s.Status(ctx, electionID, s.now().UTC())
	if err != nil {
		return false, false, err
	}
	if status == pb.ElectionStatus_ELECTION_STATUS_NOT_FOUND {
		return false, false, nil
	}
	return true, status == pb.ElectionStatus_ELECTION_STATUS_OPEN, nil
}

// CommitWhileOpen implements ballot.ElectionCommitGate. The open check is
// enforced atomically inside Commit's transaction, so this only runs commit.
func (s *Store) CommitWhileOpen(ctx context.Context, _ string, commit func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if commit == nil {
		return election.ErrInvalidElection
	}
	return commit()
}
