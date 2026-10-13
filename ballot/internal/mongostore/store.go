// Package mongostore persists elections and anonymized ballots in MongoDB.
//
// Documents never contain identity data, the raw token, client addresses or
// wall-clock timestamps; ordering is given by the per-election sequence number.
package mongostore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	ballotflow "github.com/ccelyo/Votaciones/ballot/internal/ballot"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readconcern"
	"go.mongodb.org/mongo-driver/v2/mongo/writeconcern"
)

const (
	ballotsCollection   = "ballots"
	electionsCollection = "elections"
	maxCommitAttempts   = 8
)

// errHeadMoved means another commit advanced the chain during this transaction.
var errHeadMoved = errors.New("chain head moved concurrently")

// ballotDocument is the stored ballot. _id is the SHA-256 token ID, so a token
// can be spent at most once; (election_id, seq) is unique, so the chain cannot fork.
type ballotDocument struct {
	TokenID       string `bson:"_id"`
	ElectionID    string `bson:"election_id"`
	Seq           int64  `bson:"seq"`
	EncryptedVote []byte `bson:"encrypted_vote"`
	Proof         []byte `bson:"proof"`
	PreviousHash  []byte `bson:"previous_hash"`
	BallotHash    []byte `bson:"ballot_hash"`
}

// Store implements election.Store, ballot.CommitStore, ballot.ElectionCommitGate,
// election.ParticipationCounter and the token key and state readers.
type Store struct {
	client    *mongo.Client
	ballots   *mongo.Collection
	elections *mongo.Collection
	now       func() time.Time
}

// Connect opens a client with majority read/write concerns and verifies it.
// Multi-document transactions require a replica set (MongoDB Atlas qualifies).
func Connect(ctx context.Context, uri, database string) (*Store, error) {
	if uri == "" || database == "" {
		return nil, errors.New("mongo URI and database are required")
	}
	// The 10s default goes before ApplyURI so serverSelectionTimeoutMS in the URI
	// can extend it (e.g. Cloud Run, where egress may take a few seconds at startup).
	clientOptions := options.Client().
		SetServerSelectionTimeout(10 * time.Second).
		ApplyURI(uri).
		SetAppName("votaciones-ballot").
		SetWriteConcern(writeconcern.Majority()).
		SetReadConcern(readconcern.Majority())
	client, err := mongo.Connect(clientOptions)
	if err != nil {
		return nil, fmt.Errorf("connect mongo: %w", err)
	}
	store := New(client, database)
	if err := store.Ping(ctx); err != nil {
		_ = client.Disconnect(context.Background())
		return nil, fmt.Errorf("ping mongo: %w", err)
	}
	return store, nil
}

// New wraps an existing client using the system clock.
func New(client *mongo.Client, database string) *Store {
	db := client.Database(database)
	return &Store{
		client:    client,
		ballots:   db.Collection(ballotsCollection),
		elections: db.Collection(electionsCollection),
		now:       time.Now,
	}
}

// SetClock overrides the lifecycle clock; intended for tests.
func (s *Store) SetClock(now func() time.Time) {
	if now != nil {
		s.now = now
	}
}

// EnsureIndexes creates the indexes the commit protocol relies on.
func (s *Store) EnsureIndexes(ctx context.Context) error {
	_, err := s.ballots.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "election_id", Value: 1}, {Key: "seq", Value: 1}},
			Options: options.Index().SetName("election_seq_unique").SetUnique(true),
		},
		{
			Keys:    bson.D{{Key: "election_id", Value: 1}, {Key: "ballot_hash", Value: 1}},
			Options: options.Index().SetName("election_ballot_hash_unique").SetUnique(true),
		},
	})
	if err != nil {
		return fmt.Errorf("create ballot indexes: %w", err)
	}
	return nil
}

// Ping checks primary reachability for readiness probes.
func (s *Store) Ping(ctx context.Context) error {
	return s.client.Ping(ctx, nil)
}

// Disconnect closes the client.
func (s *Store) Disconnect(ctx context.Context) error {
	return s.client.Disconnect(ctx)
}

// Commit atomically appends one ballot to the election chain. The previous hash
// is chosen server-side inside a transaction; an identical retry returns the
// original record and a different ballot with the same token is a conflict.
func (s *Store) Commit(ctx context.Context, submission ballotflow.BallotSubmission) (ballotflow.BallotRecord, token.SpendResult, error) {
	if err := validateSubmission(submission); err != nil {
		return ballotflow.BallotRecord{}, 0, err
	}
	for attempt := 0; attempt < maxCommitAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return ballotflow.BallotRecord{}, 0, err
		}
		record, result, err := s.commitOnce(ctx, submission)
		if err == nil {
			return record, result, nil
		}
		if errors.Is(err, errHeadMoved) || mongo.IsDuplicateKeyError(err) {
			// A concurrent commit won the race; re-read the token and head.
			continue
		}
		return ballotflow.BallotRecord{}, 0, err
	}
	return ballotflow.BallotRecord{}, 0, errors.New("ballot commit contention exceeded retry budget")
}

func (s *Store) commitOnce(ctx context.Context, submission ballotflow.BallotSubmission) (ballotflow.BallotRecord, token.SpendResult, error) {
	session, err := s.client.StartSession()
	if err != nil {
		return ballotflow.BallotRecord{}, 0, err
	}
	defer session.EndSession(context.Background())

	type outcome struct {
		record ballotflow.BallotRecord
		result token.SpendResult
	}
	value, err := session.WithTransaction(ctx, func(txn context.Context) (any, error) {
		var existing ballotDocument
		err := s.ballots.FindOne(txn, bson.D{{Key: "_id", Value: submission.TokenID}}).Decode(&existing)
		switch {
		case err == nil:
			if existing.ElectionID == submission.ElectionID &&
				bytes.Equal(existing.EncryptedVote, submission.EncryptedVote) &&
				bytes.Equal(existing.Proof, submission.Proof) {
				return outcome{record: existing.record(), result: token.SpendReplay}, nil
			}
			return outcome{result: token.SpendConflict}, nil
		case !errors.Is(err, mongo.ErrNoDocuments):
			return nil, err
		}

		var head electionDocument
		err = s.elections.FindOne(txn,
			bson.D{{Key: "_id", Value: submission.ElectionID}},
			options.FindOne().SetProjection(bson.D{
				{Key: "closed", Value: 1}, {Key: "opens_at", Value: 1}, {Key: "closes_at", Value: 1},
				{Key: "seq", Value: 1}, {Key: "head_hash", Value: 1},
			}),
		).Decode(&head)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, token.ErrWrongElection
		} else if err != nil {
			return nil, err
		}
		if !head.acceptsBallots(s.now().UTC()) {
			return nil, token.ErrElectionClosed
		}
		if len(head.HeadHash) != sha256.Size {
			head.HeadHash = make([]byte, sha256.Size)
		}

		ballotHash, err := ballotflow.ComputeBallotHash(submission.ElectionID, submission.EncryptedVote, submission.Proof, head.HeadHash)
		if err != nil {
			return nil, err
		}
		document := ballotDocument{
			TokenID:       submission.TokenID,
			ElectionID:    submission.ElectionID,
			Seq:           head.Seq + 1,
			EncryptedVote: submission.EncryptedVote,
			Proof:         submission.Proof,
			PreviousHash:  head.HeadHash,
			BallotHash:    ballotHash[:],
		}
		if _, err := s.ballots.InsertOne(txn, document); err != nil {
			return nil, err
		}

		// Advancing the head writes the election document, so this transaction
		// conflicts with any concurrent Close or commit on the same election.
		updated, err := s.elections.UpdateOne(txn,
			bson.D{{Key: "_id", Value: submission.ElectionID}, {Key: "closed", Value: false}, {Key: "seq", Value: head.Seq}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "seq", Value: document.Seq}, {Key: "head_hash", Value: document.BallotHash}}}},
		)
		if err != nil {
			return nil, err
		}
		if updated.MatchedCount != 1 {
			return nil, errHeadMoved
		}
		return outcome{record: document.record(), result: token.SpendNew}, nil
	})
	if err != nil {
		return ballotflow.BallotRecord{}, 0, err
	}
	result := value.(outcome)
	return result.record, result.result, nil
}

// CountBallots returns participation only and never reads vote contents.
func (s *Store) CountBallots(ctx context.Context, electionID string) (uint64, error) {
	count, err := s.ballots.CountDocuments(ctx, bson.D{{Key: "election_id", Value: electionID}})
	if err != nil {
		return 0, err
	}
	return uint64(count), nil
}

func (d ballotDocument) record() ballotflow.BallotRecord {
	return ballotflow.BallotRecord{
		ElectionID:    d.ElectionID,
		TokenID:       d.TokenID,
		EncryptedVote: append([]byte(nil), d.EncryptedVote...),
		Proof:         append([]byte(nil), d.Proof...),
		PreviousHash:  append([]byte(nil), d.PreviousHash...),
		BallotHash:    append([]byte(nil), d.BallotHash...),
	}
}

func validateSubmission(submission ballotflow.BallotSubmission) error {
	if _, err := ballotflow.ComputeBallotHash(submission.ElectionID, submission.EncryptedVote, submission.Proof, make([]byte, sha256.Size)); err != nil {
		return ballotflow.ErrInvalidBallot
	}
	decoded, err := hex.DecodeString(submission.TokenID)
	if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != submission.TokenID {
		return ballotflow.ErrInvalidBallot
	}
	return nil
}
