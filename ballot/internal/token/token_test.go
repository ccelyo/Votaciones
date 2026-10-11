package token

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"strings"
	"testing"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

//go:embed testdata/rfc9474.json.gz
var rfcVectors embed.FS

type testKeyResolver map[string]VerificationKey

func (r testKeyResolver) ResolveTokenKey(_ context.Context, _ string, kid string) (VerificationKey, bool, error) {
	key, ok := r[kid]
	return key, ok, nil
}

type testElectionState struct {
	exists bool
	open   bool
}

func (s testElectionState) ElectionState(context.Context, string) (bool, bool, error) {
	return s.exists, s.open, nil
}

func makeTestToken(t *testing.T, key *rsa.PrivateKey, electionID, kid string) []byte {
	t.Helper()
	nonce := make([]byte, TokenNonceSize)
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}

	message, err := CanonicalTokenMessage(electionID, nonce)
	if err != nil {
		t.Fatal(err)
	}
	client, err := blindrsa.NewClient(blindrsa.SHA384PSSRandomized, &key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := client.Prepare(rand.Reader, message)
	if err != nil {
		t.Fatal(err)
	}
	blinded, state, err := client.Blind(rand.Reader, prepared)
	if err != nil {
		t.Fatal(err)
	}
	blindSignature, err := blindrsa.NewSigner(key).BlindSign(blinded)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := client.Finalize(state, blindSignature)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := MarshalSignedToken(SignedToken{
		Version:         TokenVersion,
		KeyID:           kid,
		ElectionID:      electionID,
		Nonce:           nonce,
		PreparedMessage: prepared,
		Signature:       signature,
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestVerifySignedToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	resolver := testKeyResolver{"key-1": {PublicKey: &key.PublicKey, Variant: RSABSSASHA384PSSRandomized}}
	verifier := NewVerifier(resolver, testElectionState{exists: true, open: true})
	tokenBytes := makeTestToken(t, key, "election-1", "key-1")

	if err := verifier.Verify(context.Background(), "election-1", tokenBytes); err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}

	tampered, err := ParseSignedToken(tokenBytes)
	if err != nil {
		t.Fatal(err)
	}
	tampered.Signature[len(tampered.Signature)-1] ^= 1
	badToken, err := MarshalSignedToken(tampered)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifier.Verify(context.Background(), "election-1", badToken); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("altered signature error = %v, want ErrInvalidSignature", err)
	}
}

func TestVerifyRejectsWrongElectionAndClosedElection(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	resolver := testKeyResolver{"key-1": {PublicKey: &key.PublicKey, Variant: RSABSSASHA384PSSRandomized}}
	tokenBytes := makeTestToken(t, key, "election-1", "key-1")

	openVerifier := NewVerifier(resolver, testElectionState{exists: true, open: true})
	if err := openVerifier.Verify(context.Background(), "election-2", tokenBytes); !errors.Is(err, ErrWrongElection) {
		t.Fatalf("wrong election error = %v, want ErrWrongElection", err)
	}
	closedVerifier := NewVerifier(resolver, testElectionState{exists: true, open: false})
	if err := closedVerifier.Verify(context.Background(), "election-1", tokenBytes); !errors.Is(err, ErrElectionClosed) {
		t.Fatalf("closed election error = %v, want ErrElectionClosed", err)
	}
}

func TestVerifySupportsKeyRotationAndRejectsUnknownKey(t *testing.T) {
	oldKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	newKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	resolver := testKeyResolver{
		"old-kid": {PublicKey: &oldKey.PublicKey, Variant: RSABSSASHA384PSSRandomized},
		"new-kid": {PublicKey: &newKey.PublicKey, Variant: RSABSSASHA384PSSRandomized},
	}
	verifier := NewVerifier(resolver, testElectionState{exists: true, open: true})
	if err := verifier.Verify(context.Background(), "election-1", makeTestToken(t, oldKey, "election-1", "old-kid")); err != nil {
		t.Fatalf("rotated key rejected: %v", err)
	}
	unknownKidToken := makeTestToken(t, oldKey, "election-1", "retired-kid")
	if err := verifier.Verify(context.Background(), "election-1", unknownKidToken); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("unknown kid error = %v, want ErrInvalidSignature", err)
	}
}

func TestVerifyRejectsMalformedAndCanceledRequests(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	verifier := NewVerifier(testKeyResolver{"key-1": {PublicKey: &key.PublicKey, Variant: RSABSSASHA384PSSRandomized}}, testElectionState{exists: true, open: true})
	if err := verifier.Verify(context.Background(), "election-1", []byte("not-a-token")); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("malformed token error = %v, want ErrInvalidToken", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := verifier.Verify(ctx, "election-1", []byte("not-a-token")); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request error = %v, want context.Canceled", err)
	}
}

type rfcVector struct {
	Name     string `json:"name"`
	N        string `json:"n"`
	E        string `json:"e"`
	InputMsg string `json:"input_msg"`
	Sig      string `json:"sig"`
}

func decodeRFCInteger(t *testing.T, value string) *big.Int {
	t.Helper()
	decoded, err := hex.DecodeString(strings.TrimPrefix(value, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	return new(big.Int).SetBytes(decoded)
}

func TestRFC9474Vectors(t *testing.T) {
	fixture, err := rfcVectors.Open("testdata/rfc9474.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer fixture.Close()

	reader, err := gzip.NewReader(fixture)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	encoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var vectors []rfcVector
	if err := json.Unmarshal(encoded, &vectors); err != nil {
		t.Fatal(err)
	}

	for _, vector := range vectors {
		t.Run(vector.Name, func(t *testing.T) {
			var variant string
			switch vector.Name {
			case "RSABSSA-SHA384-PSS-Randomized":
				variant = RSABSSASHA384PSSRandomized
			case "RSABSSA-SHA384-PSSZERO-Randomized":
				variant = RSABSSASHA384PSSZeroRandomized
			case "RSABSSA-SHA384-PSS-Deterministic":
				variant = RSABSSASHA384PSSDeterministic
			case "RSABSSA-SHA384-PSSZERO-Deterministic":
				variant = RSABSSASHA384PSSZeroDeterministic
			default:
				t.Fatalf("unknown RFC vector variant %q", vector.Name)
			}
			n := decodeRFCInteger(t, vector.N)
			e := decodeRFCInteger(t, vector.E)
			prepared, err := hex.DecodeString(strings.TrimPrefix(vector.InputMsg, "0x"))
			if err != nil {
				t.Fatal(err)
			}
			signature, err := hex.DecodeString(strings.TrimPrefix(vector.Sig, "0x"))
			if err != nil {
				t.Fatal(err)
			}
			if err := verifyPreparedMessage(variant, &rsa.PublicKey{N: n, E: int(e.Int64())}, prepared, signature); err != nil {
				t.Fatalf("RFC 9474 signature rejected: %v", err)
			}
		})
	}
}

func TestParseSignedTokenRejectsUnknownJSONFields(t *testing.T) {
	malformed := base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"unknown":true}`))
	if _, err := ParseSignedToken([]byte(malformed)); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("unknown JSON field error = %v, want ErrInvalidToken", err)
	}
}
