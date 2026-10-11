package token

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

const ReceiptPrivateKeyEnv = "BALLOT_RECEIPT_PRIVATE_KEY"

var (
	ErrInvalidReceipt    = errors.New("invalid receipt")
	ErrMissingReceiptKey = errors.New("receipt signing key is not configured")
	ErrInvalidReceiptKey = errors.New("receipt signing key is invalid")
)

var receiptDomain = []byte("votaciones.ballot.receipt.v1\x00")

// SignedReceipt contains only an election ID, a ballot digest and its signature.
type SignedReceipt struct {
	Version    uint8
	ElectionID string
	BallotHash []byte
	Signature  []byte
}

type receiptWire struct {
	Version    uint8  `json:"v"`
	ElectionID string `json:"election_id"`
	BallotHash string `json:"ballot_hash"`
	Signature  string `json:"signature"`
}

// SignReceipt signs a domain-separated encoding of election ID and SHA-256 ballot hash.
func SignReceipt(privateKey ed25519.PrivateKey, electionID string, ballotHash []byte) (SignedReceipt, error) {
	if len(privateKey) != ed25519.PrivateKeySize || !validIdentifier(electionID, 128) || len(ballotHash) != BallotHashSize {
		return SignedReceipt{}, ErrInvalidReceipt
	}
	message := receiptMessage(electionID, ballotHash)
	return SignedReceipt{
		Version:    TokenVersion,
		ElectionID: electionID,
		BallotHash: append([]byte(nil), ballotHash...),
		Signature:  ed25519.Sign(privateKey, message),
	}, nil
}

// VerifyReceipt verifies the Ed25519 signature over the receipt's public fields.
func VerifyReceipt(publicKey ed25519.PublicKey, receipt SignedReceipt) error {
	if len(publicKey) != ed25519.PublicKeySize || receipt.Version != TokenVersion ||
		!validIdentifier(receipt.ElectionID, 128) || len(receipt.BallotHash) != BallotHashSize ||
		len(receipt.Signature) != ed25519.SignatureSize {
		return ErrInvalidReceipt
	}
	if !ed25519.Verify(publicKey, receiptMessage(receipt.ElectionID, receipt.BallotHash), receipt.Signature) {
		return ErrInvalidReceipt
	}
	return nil
}

// MarshalReceipt serializes a receipt into a canonical, base64url JSON envelope.
func MarshalReceipt(receipt SignedReceipt) ([]byte, error) {
	if err := validateReceipt(receipt); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(receiptWire{
		Version:    receipt.Version,
		ElectionID: receipt.ElectionID,
		BallotHash: base64.RawURLEncoding.EncodeToString(receipt.BallotHash),
		Signature:  base64.RawURLEncoding.EncodeToString(receipt.Signature),
	})
	if err != nil {
		return nil, fmt.Errorf("encode receipt: %w", err)
	}
	result := make([]byte, base64.RawURLEncoding.EncodedLen(len(encoded)))
	base64.RawURLEncoding.Encode(result, encoded)
	return result, nil
}

// ParseReceipt strictly parses a canonical receipt envelope.
func ParseReceipt(encoded []byte) (SignedReceipt, error) {
	if len(encoded) == 0 || len(encoded) > maxTokenBytes {
		return SignedReceipt{}, ErrInvalidReceipt
	}
	jsonBytes, err := base64.RawURLEncoding.Strict().DecodeString(string(encoded))
	if err != nil {
		return SignedReceipt{}, ErrInvalidReceipt
	}
	decoder := json.NewDecoder(bytes.NewReader(jsonBytes))
	decoder.DisallowUnknownFields()
	var wire receiptWire
	if err := decoder.Decode(&wire); err != nil {
		return SignedReceipt{}, ErrInvalidReceipt
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return SignedReceipt{}, ErrInvalidReceipt
	}
	ballotHash, err := base64.RawURLEncoding.Strict().DecodeString(wire.BallotHash)
	if err != nil {
		return SignedReceipt{}, ErrInvalidReceipt
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(wire.Signature)
	if err != nil {
		return SignedReceipt{}, ErrInvalidReceipt
	}
	receipt := SignedReceipt{Version: wire.Version, ElectionID: wire.ElectionID, BallotHash: ballotHash, Signature: signature}
	if err := validateReceipt(receipt); err != nil {
		return SignedReceipt{}, err
	}
	canonical, err := MarshalReceipt(receipt)
	if err != nil || !bytes.Equal(canonical, encoded) {
		return SignedReceipt{}, ErrInvalidReceipt
	}
	return receipt, nil
}

// LoadReceiptPrivateKey reads the raw 64-byte Ed25519 private key from a base64url
// or standard-base64 environment variable. It never falls back to a compiled key.
func LoadReceiptPrivateKey() (ed25519.PrivateKey, error) {
	encoded := os.Getenv(ReceiptPrivateKeyEnv)
	if encoded == "" {
		return nil, ErrMissingReceiptKey
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		decoded, err = base64.StdEncoding.Strict().DecodeString(encoded)
	}
	if err != nil || len(decoded) != ed25519.PrivateKeySize {
		return nil, ErrInvalidReceiptKey
	}
	return ed25519.PrivateKey(append([]byte(nil), decoded...)), nil
}

func receiptMessage(electionID string, ballotHash []byte) []byte {
	message := make([]byte, len(receiptDomain)+2+len(electionID)+len(ballotHash))
	copy(message, receiptDomain)
	position := len(receiptDomain)
	message[position] = byte(len(electionID) >> 8)
	message[position+1] = byte(len(electionID))
	position += 2
	copy(message[position:], electionID)
	copy(message[position+len(electionID):], ballotHash)
	return message
}

func validateReceipt(receipt SignedReceipt) error {
	if receipt.Version != TokenVersion || !validIdentifier(receipt.ElectionID, 128) ||
		len(receipt.BallotHash) != BallotHashSize || len(receipt.Signature) != ed25519.SignatureSize {
		return ErrInvalidReceipt
	}
	return nil
}
