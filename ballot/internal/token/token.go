// Package token verifies election-bound RFC 9474 anonymous voting tokens.
package token

import (
	"bytes"
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

const (
	// TokenVersion is the currently supported token envelope version.
	TokenVersion uint8 = 1
	// TokenNonceSize is the required size of a browser-generated token nonce.
	TokenNonceSize = 32
	// BallotHashSize is the SHA-256 ballot digest size in bytes.
	BallotHashSize = sha256.Size
	// RSABSSASHA384PSSRandomized is the proposed M6-compatible RFC 9474 variant.
	RSABSSASHA384PSSRandomized = "RSABSSA-SHA384-PSS-Randomized"
	// RSABSSASHA384PSSZeroRandomized is supported for migration compatibility.
	RSABSSASHA384PSSZeroRandomized = "RSABSSA-SHA384-PSSZERO-Randomized"
	// RSABSSASHA384PSSDeterministic is supported for test vector verification.
	RSABSSASHA384PSSDeterministic = "RSABSSA-SHA384-PSS-Deterministic"
	// RSABSSASHA384PSSZeroDeterministic is supported for test vector verification.
	RSABSSASHA384PSSZeroDeterministic = "RSABSSA-SHA384-PSSZERO-Deterministic"

	maxTokenBytes = 16 * 1024
)

var (
	// ErrInvalidSignature means the token signature or key identifier is invalid.
	ErrInvalidSignature = errors.New("invalid token signature")
	// ErrWrongElection means the signed token is bound to another election.
	ErrWrongElection = errors.New("token belongs to another election")
	// ErrElectionClosed means the token cannot be used because the election is closed.
	ErrElectionClosed = errors.New("election is closed")
	// ErrAlreadySpent means the token was committed with a different ballot.
	ErrAlreadySpent = errors.New("token already spent")
	// ErrInvalidToken means the token envelope or its fields are malformed.
	ErrInvalidToken = errors.New("invalid token")
	// ErrInvalidSpend means a spend request is missing a valid identifier or digest.
	ErrInvalidSpend = errors.New("invalid spent-token request")
)

var tokenDomain = []byte("votaciones.ballot.anonymous-token.v1\x00")

// SignedToken is the canonical content carried by the base64url token envelope.
// PreparedMessage contains RFC 9474's 32-byte randomizer prefix followed by the
// canonical election-bound message. The blind signature covers PreparedMessage.
type SignedToken struct {
	Version         uint8
	KeyID           string
	ElectionID      string
	Nonce           []byte
	PreparedMessage []byte
	Signature       []byte
}

type tokenWire struct {
	Version         uint8  `json:"v"`
	KeyID           string `json:"kid"`
	ElectionID      string `json:"election_id"`
	Nonce           string `json:"nonce"`
	PreparedMessage string `json:"prepared_message"`
	Signature       string `json:"signature"`
}

// VerificationKey is a public RSABSSA key and its RFC 9474 variant.
type VerificationKey struct {
	PublicKey *rsa.PublicKey
	Variant   string
}

// KeyResolver finds a key by election and key ID, allowing overlapping key rotation.
type KeyResolver interface {
	ResolveTokenKey(ctx context.Context, electionID, kid string) (VerificationKey, bool, error)
}

// ElectionStateReader reports existence and whether new ballots are accepted.
type ElectionStateReader interface {
	ElectionState(ctx context.Context, electionID string) (exists, open bool, err error)
}

// Verifier validates token parsing, election binding, lifecycle, key ID and signature.
type Verifier struct {
	keys      KeyResolver
	elections ElectionStateReader
}

// NewVerifier creates a token verifier using the registered election keys and state.
func NewVerifier(keys KeyResolver, elections ElectionStateReader) *Verifier {
	return &Verifier{keys: keys, elections: elections}
}

// CanonicalTokenMessage returns the versioned byte string the browser blinds and
// identity signs. Fields are length-prefixed to prevent ambiguous concatenation.
func CanonicalTokenMessage(electionID string, nonce []byte) ([]byte, error) {
	if !validIdentifier(electionID, 128) || len(nonce) != TokenNonceSize {
		return nil, ErrInvalidToken
	}
	message := make([]byte, len(tokenDomain)+2+len(electionID)+TokenNonceSize)
	copy(message, tokenDomain)
	position := len(tokenDomain)
	message[position] = byte(len(electionID) >> 8)
	message[position+1] = byte(len(electionID))
	position += 2
	copy(message[position:], electionID)
	copy(message[position+len(electionID):], nonce)
	return message, nil
}

// MarshalSignedToken validates and encodes a token as unpadded base64url JSON.
func MarshalSignedToken(token SignedToken) ([]byte, error) {
	if err := validateSignedToken(token); err != nil {
		return nil, err
	}
	wire := tokenWire{
		Version:         token.Version,
		KeyID:           token.KeyID,
		ElectionID:      token.ElectionID,
		Nonce:           base64.RawURLEncoding.EncodeToString(token.Nonce),
		PreparedMessage: base64.RawURLEncoding.EncodeToString(token.PreparedMessage),
		Signature:       base64.RawURLEncoding.EncodeToString(token.Signature),
	}
	encoded, err := json.Marshal(wire)
	if err != nil {
		return nil, fmt.Errorf("encode token: %w", err)
	}
	result := make([]byte, base64.RawURLEncoding.EncodedLen(len(encoded)))
	base64.RawURLEncoding.Encode(result, encoded)
	if len(result) > maxTokenBytes {
		return nil, ErrInvalidToken
	}
	return result, nil
}

// ParseSignedToken strictly parses a canonical token envelope.
func ParseSignedToken(encoded []byte) (SignedToken, error) {
	if len(encoded) == 0 || len(encoded) > maxTokenBytes {
		return SignedToken{}, ErrInvalidToken
	}
	jsonBytes, err := base64.RawURLEncoding.Strict().DecodeString(string(encoded))
	if err != nil {
		return SignedToken{}, ErrInvalidToken
	}
	decoder := json.NewDecoder(bytes.NewReader(jsonBytes))
	decoder.DisallowUnknownFields()
	var wire tokenWire
	if err := decoder.Decode(&wire); err != nil {
		return SignedToken{}, ErrInvalidToken
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return SignedToken{}, ErrInvalidToken
	}
	nonce, err := decodeBase64URL(wire.Nonce)
	if err != nil {
		return SignedToken{}, ErrInvalidToken
	}
	prepared, err := decodeBase64URL(wire.PreparedMessage)
	if err != nil {
		return SignedToken{}, ErrInvalidToken
	}
	signature, err := decodeBase64URL(wire.Signature)
	if err != nil {
		return SignedToken{}, ErrInvalidToken
	}
	parsed := SignedToken{
		Version:         wire.Version,
		KeyID:           wire.KeyID,
		ElectionID:      wire.ElectionID,
		Nonce:           nonce,
		PreparedMessage: prepared,
		Signature:       signature,
	}
	if err := validateSignedToken(parsed); err != nil {
		return SignedToken{}, err
	}
	canonical, err := MarshalSignedToken(parsed)
	if err != nil || !bytes.Equal(canonical, encoded) {
		return SignedToken{}, ErrInvalidToken
	}
	return parsed, nil
}

// Verify checks the signed token against the election's registered key set.
func (v *Verifier) Verify(ctx context.Context, electionID string, encoded []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if v == nil || v.keys == nil || v.elections == nil || !validIdentifier(electionID, 128) {
		return ErrInvalidToken
	}
	parsed, err := ParseSignedToken(encoded)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare([]byte(parsed.ElectionID), []byte(electionID)) != 1 {
		return ErrWrongElection
	}
	exists, open, err := v.elections.ElectionState(ctx, electionID)
	if err != nil {
		return err
	}
	if !exists {
		return ErrWrongElection
	}
	if !open {
		return ErrElectionClosed
	}
	key, found, err := v.keys.ResolveTokenKey(ctx, electionID, parsed.KeyID)
	if err != nil {
		return err
	}
	if !found || key.PublicKey == nil || key.PublicKey.N == nil || key.PublicKey.N.BitLen() < 2048 ||
		(key.Variant != RSABSSASHA384PSSRandomized && key.Variant != RSABSSASHA384PSSZeroRandomized) {
		return ErrInvalidSignature
	}
	message, err := CanonicalTokenMessage(parsed.ElectionID, parsed.Nonce)
	if err != nil || len(parsed.PreparedMessage) < randomizedPrefixSize+len(message) {
		return ErrInvalidToken
	}
	if subtle.ConstantTimeCompare(parsed.PreparedMessage[randomizedPrefixSize:], message) != 1 {
		return ErrInvalidSignature
	}
	if len(parsed.Signature) != key.PublicKey.Size() {
		return ErrInvalidSignature
	}
	return verifyPreparedMessage(key.Variant, key.PublicKey, parsed.PreparedMessage, parsed.Signature)
}

// TokenID returns the lowercase hexadecimal SHA-256 digest used as MongoDB _id.
func TokenID(encoded []byte) string {
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

const randomizedPrefixSize = 32

func verifyPreparedMessage(variant string, publicKey *rsa.PublicKey, prepared, signature []byte) error {
	var libraryVariant blindrsa.Variant
	switch variant {
	case RSABSSASHA384PSSRandomized:
		libraryVariant = blindrsa.SHA384PSSRandomized
	case RSABSSASHA384PSSZeroRandomized:
		libraryVariant = blindrsa.SHA384PSSZeroRandomized
	case RSABSSASHA384PSSDeterministic:
		libraryVariant = blindrsa.SHA384PSSDeterministic
	case RSABSSASHA384PSSZeroDeterministic:
		libraryVariant = blindrsa.SHA384PSSZeroDeterministic
	default:
		return ErrInvalidSignature
	}
	verifier, err := blindrsa.NewVerifier(libraryVariant, publicKey)
	if err != nil {
		return ErrInvalidSignature
	}
	if err := verifier.Verify(prepared, signature); err != nil {
		return ErrInvalidSignature
	}
	return nil
}

func validateSignedToken(token SignedToken) error {
	if token.Version != TokenVersion || !validIdentifier(token.KeyID, 64) || !validIdentifier(token.ElectionID, 128) ||
		len(token.Nonce) != TokenNonceSize || len(token.PreparedMessage) < randomizedPrefixSize+len(tokenDomain)+2+TokenNonceSize ||
		len(token.PreparedMessage) > 1024 || len(token.Signature) < 256 || len(token.Signature) > 1024 {
		return ErrInvalidToken
	}
	return nil
}

func validIdentifier(value string, maxBytes int) bool {
	if len(value) == 0 || len(value) > maxBytes || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character < 0x21 || character == 0x7f || unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func decodeBase64URL(encoded string) ([]byte, error) {
	if encoded == "" {
		return nil, ErrInvalidToken
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return nil, ErrInvalidToken
	}
	return decoded, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if !errors.Is(err, io.EOF) {
		return ErrInvalidToken
	}
	return nil
}
