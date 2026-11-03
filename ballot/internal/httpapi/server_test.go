package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ballotflow "github.com/ccelyo/Votaciones/ballot/internal/ballot"
	"github.com/ccelyo/Votaciones/ballot/internal/election"
	"github.com/ccelyo/Votaciones/ballot/internal/token"
	"github.com/cloudflare/circl/blindsign/blindrsa"
)

type fixture struct {
	handler     http.Handler
	elections   *election.MemoryStore
	ballots     *ballotflow.MemoryCommitStore
	identityKey *rsa.PrivateKey
	receiptKey  ed25519.PublicKey
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	identityKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&identityKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	receiptPublic, receiptPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	elections := election.NewMemoryStore()
	if _, err := elections.Register(context.Background(), election.Election{
		ID:                  "gobernacion-antioquia-2027",
		Options:             []string{"candidato-1", "candidato-2", "voto-en-blanco"},
		EncryptionPublicKey: []byte("election-public-key"),
		TokenKeys:           []election.TokenKey{{KID: "key-1", PublicKeyDER: publicDER, SignatureVariant: token.RSABSSASHA384PSSRandomized}},
		OpensAt:             now.Add(-time.Hour),
		ClosesAt:            now.Add(time.Hour),
		SignedParameters:    []byte("signed-parameters"),
		SigningKeyID:        "params-1",
		SignatureAlgorithm:  "Ed25519",
		ParameterSignature:  []byte("signature"),
	}); err != nil {
		t.Fatal(err)
	}
	ballots := ballotflow.NewMemoryCommitStore()
	acceptor := ballotflow.NewAcceptor(token.NewVerifier(elections, elections), ballotflow.StructuralProofVerifier{}, ballots, elections, receiptPrivate)
	return fixture{
		handler: NewHandler(Config{
			Acceptor:       acceptor,
			Elections:      elections,
			Votes:          ballots,
			AllowedOrigins: []string{"https://votaciones.example"},
		}),
		elections:   elections,
		ballots:     ballots,
		identityKey: identityKey,
		receiptKey:  receiptPublic,
	}
}

func (f fixture) post(t *testing.T, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/ballots", bytes.NewReader(encoded))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, request)
	return recorder
}

func TestSubmitBallotIssuesReceiptAndHandlesReplay(t *testing.T) {
	f := newFixture(t)
	submission := SubmitBallotRequest{
		ElectionID:    "gobernacion-antioquia-2027",
		Token:         string(signedToken(t, f.identityKey, "gobernacion-antioquia-2027")),
		EncryptedVote: b64("ciphertext"),
		Proof:         b64("proof"),
	}

	first := f.post(t, submission)
	if first.Code != http.StatusCreated {
		t.Fatalf("first submit status = %d body=%s", first.Code, first.Body)
	}
	if cookies := first.Result().Cookies(); len(cookies) != 0 {
		t.Fatal("ballot response must never set cookies")
	}
	var response SubmitBallotResponse
	if err := json.Unmarshal(first.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	receipt, err := token.ParseReceipt([]byte(response.Receipt))
	if err != nil {
		t.Fatal(err)
	}
	if err := token.VerifyReceipt(f.receiptKey, receipt); err != nil {
		t.Fatalf("receipt did not verify: %v", err)
	}

	replay := f.post(t, submission)
	if replay.Code != http.StatusOK || !strings.Contains(replay.Body.String(), response.Receipt) {
		t.Fatalf("replay status = %d body=%s", replay.Code, replay.Body)
	}

	submission.EncryptedVote = b64("other-ciphertext")
	if conflict := f.post(t, submission); conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "token_already_spent") {
		t.Fatalf("double vote status = %d body=%s", conflict.Code, conflict.Body)
	}
	if count := f.ballots.Count("gobernacion-antioquia-2027"); count != 1 {
		t.Fatalf("stored ballots = %d, want 1", count)
	}
}

func TestSubmitBallotRejections(t *testing.T) {
	f := newFixture(t)
	validToken := string(signedToken(t, f.identityKey, "gobernacion-antioquia-2027"))
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		body   any
		status int
		code   string
	}{
		{"unknown field", map[string]string{"election_id": "x", "user_id": "123"}, http.StatusBadRequest, "invalid_request"},
		{"bad base64", SubmitBallotRequest{ElectionID: "gobernacion-antioquia-2027", Token: validToken, EncryptedVote: "!!", Proof: b64("p")}, http.StatusBadRequest, "invalid_request"},
		{"garbage token", SubmitBallotRequest{ElectionID: "gobernacion-antioquia-2027", Token: "abc", EncryptedVote: b64("c"), Proof: b64("p")}, http.StatusBadRequest, "invalid_token"},
		{"forged token", SubmitBallotRequest{ElectionID: "gobernacion-antioquia-2027", Token: string(signedToken(t, otherKey, "gobernacion-antioquia-2027")), EncryptedVote: b64("c"), Proof: b64("p")}, http.StatusForbidden, "invalid_token_signature"},
		{"wrong election", SubmitBallotRequest{ElectionID: "alcaldia-medellin-2027", Token: validToken, EncryptedVote: b64("c"), Proof: b64("p")}, http.StatusForbidden, "token_election_mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := f.post(t, tc.body)
			if recorder.Code != tc.status || !strings.Contains(recorder.Body.String(), tc.code) {
				t.Fatalf("status = %d body=%s, want %d %s", recorder.Code, recorder.Body, tc.status, tc.code)
			}
		})
	}
	if count := f.ballots.Count("gobernacion-antioquia-2027"); count != 0 {
		t.Fatalf("rejected ballots were stored: %d", count)
	}
}

func TestSubmitBallotAfterCloseIsRejected(t *testing.T) {
	f := newFixture(t)
	if _, err := f.elections.Close(context.Background(), "gobernacion-antioquia-2027", time.Now()); err != nil {
		t.Fatal(err)
	}
	recorder := f.post(t, SubmitBallotRequest{
		ElectionID:    "gobernacion-antioquia-2027",
		Token:         string(signedToken(t, f.identityKey, "gobernacion-antioquia-2027")),
		EncryptedVote: b64("c"),
		Proof:         b64("p"),
	})
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "election_not_open") {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body)
	}
}

func TestElectionParameters(t *testing.T) {
	f := newFixture(t)
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/elections/gobernacion-antioquia-2027/parameters", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body)
	}
	var response ElectionParametersResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Status != "open" || len(response.Options) != 3 || len(response.TokenKeys) != 1 || response.TokenKeys[0].KID != "key-1" {
		t.Fatalf("unexpected parameters: %+v", response)
	}

	missing := httptest.NewRecorder()
	f.handler.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/v1/elections/nope/parameters", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing election status = %d", missing.Code)
	}
}

func TestElectionResultsOnlyAfterClose(t *testing.T) {
	f := newFixture(t)
	const electionID = "gobernacion-antioquia-2027"
	for _, vote := range []string{"candidato-1", "candidato-2", "candidato-1", "stub-encrypted-vote"} {
		recorder := f.post(t, SubmitBallotRequest{
			ElectionID:    electionID,
			Token:         string(signedToken(t, f.identityKey, electionID)),
			EncryptedVote: b64(vote),
			Proof:         b64("proof"),
		})
		if recorder.Code != http.StatusCreated {
			t.Fatalf("submit status = %d body=%s", recorder.Code, recorder.Body)
		}
	}

	results := func() *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		f.handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/elections/"+electionID+"/results", nil))
		return recorder
	}
	if open := results(); open.Code != http.StatusConflict || !strings.Contains(open.Body.String(), "election_not_closed") {
		t.Fatalf("open election results status = %d body=%s", open.Code, open.Body)
	}

	if _, err := f.elections.Close(context.Background(), electionID, time.Now()); err != nil {
		t.Fatal(err)
	}
	closed := results()
	if closed.Code != http.StatusOK {
		t.Fatalf("closed election results status = %d body=%s", closed.Code, closed.Body)
	}
	var response ElectionResultsResponse
	if err := json.Unmarshal(closed.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	want := []OptionResultResponse{{"candidato-1", 2}, {"candidato-2", 1}, {"voto-en-blanco", 0}}
	if response.TotalBallots != 4 || response.InvalidBallots != 1 || len(response.Results) != len(want) {
		t.Fatalf("unexpected results: %+v", response)
	}
	for i, result := range want {
		if response.Results[i] != result {
			t.Fatalf("result %d = %+v, want %+v", i, response.Results[i], result)
		}
	}

	missing := httptest.NewRecorder()
	f.handler.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/v1/elections/nope/results", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing election status = %d", missing.Code)
	}
}

func TestCORSNeverAllowsCredentials(t *testing.T) {
	f := newFixture(t)
	request := httptest.NewRequest(http.MethodOptions, "/v1/ballots", nil)
	request.Header.Set("Origin", "https://votaciones.example")
	request.Header.Set("Access-Control-Request-Method", "POST")
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent || recorder.Header().Get("Access-Control-Allow-Origin") != "https://votaciones.example" {
		t.Fatalf("preflight status = %d headers=%v", recorder.Code, recorder.Header())
	}
	if recorder.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("CORS must not allow credentials on the anonymous ballot API")
	}

	request.Header.Set("Origin", "https://evil.example")
	denied := httptest.NewRecorder()
	f.handler.ServeHTTP(denied, request)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("foreign origin preflight status = %d", denied.Code)
	}
}

func b64(value string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(value))
}

func signedToken(t *testing.T, identityKey *rsa.PrivateKey, electionID string) []byte {
	t.Helper()
	nonce := make([]byte, token.TokenNonceSize)
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	message, err := token.CanonicalTokenMessage(electionID, nonce)
	if err != nil {
		t.Fatal(err)
	}
	client, err := blindrsa.NewClient(blindrsa.SHA384PSSRandomized, &identityKey.PublicKey)
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
	blindSignature, err := blindrsa.NewSigner(identityKey).BlindSign(blinded)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := client.Finalize(state, blindSignature)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := token.MarshalSignedToken(token.SignedToken{
		Version:         token.TokenVersion,
		KeyID:           "key-1",
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
