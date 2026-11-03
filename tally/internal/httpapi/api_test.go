package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ccelyo/Votaciones/tally/internal/ballotclient"
	"github.com/ccelyo/Votaciones/tally/internal/count"
	"github.com/ccelyo/Votaciones/tally/internal/decrypt"
	"github.com/ccelyo/Votaciones/tally/internal/publisher"
	"github.com/ccelyo/Votaciones/tally/internal/tally"
)

type fakeService struct {
	completed    tally.Completed
	err          error
	last         tally.RunRequest
	checkContext bool
}

func (f *fakeService) Run(ctx context.Context, _ string, request tally.RunRequest) (tally.Completed, error) {
	if f.checkContext && ctx.Err() != nil {
		return tally.Completed{}, ctx.Err()
	}
	f.last = request
	return f.completed, f.err
}

func (f *fakeService) Get(string) (tally.Completed, error) {
	return f.completed, f.err
}

func TestPostRunDecodesRequestAndReturnsCount(t *testing.T) {
	service := &fakeService{completed: tally.Completed{
		ElectionID:     "e1",
		TotalBallots:   3,
		InvalidBallots: 0,
		Results:        []count.OptionCount{{Option: "a", Votes: 2}, {Option: "b", Votes: 1}},
		TalliedAt:      time.Date(2026, 11, 2, 18, 0, 0, 0, time.UTC),
		EventID:        "00000000-0000-5000-8000-000000000000",
	}}
	handler := NewHandler(Config{Service: service})

	body := bytes.NewBufferString(`{"private_key":"PEM-HERE","republish":true}`)
	request := httptest.NewRequest(http.MethodPost, "/v1/tally/elections/e1", body)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body)
	}
	if service.last.PrivateKey == nil || string(service.last.PrivateKey) != "PEM-HERE" || !service.last.Republish {
		t.Fatalf("request not decoded: %+v", service.last)
	}
	var response tally.Completed
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.TotalBallots != 3 || response.EventID == "" {
		t.Fatalf("unexpected response: %s", recorder.Body)
	}
}

func TestRunSurvivesClientDisconnect(t *testing.T) {
	service := &fakeService{
		checkContext: true,
		completed:    tally.Completed{ElectionID: "e1", EventID: "event"},
	}
	handler := NewHandler(Config{Service: service})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/v1/tally/elections/e1", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body)
	}
}

func TestPostRunRejectsUnknownFields(t *testing.T) {
	handler := NewHandler(Config{Service: &fakeService{}})
	request := httptest.NewRequest(http.MethodPost, "/v1/tally/elections/e1", strings.NewReader(`{"election_id":"e2"}`))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestGetPendingAndErrorMapping(t *testing.T) {
	cases := []struct {
		err  error
		code int
		body string
	}{
		{tally.ErrTallyPending, http.StatusNotFound, "tally_pending"},
		{ballotclient.ErrElectionNotFound, http.StatusNotFound, "election_not_found"},
		{ballotclient.ErrElectionNotClosed, http.StatusConflict, "election_not_closed"},
		{tally.ErrWrongPrivateKey, http.StatusBadRequest, "invalid_private_key"},
		{decrypt.ErrInvalidPrivateKey, http.StatusBadRequest, "invalid_private_key"},
		{decrypt.ErrPrivateKeyRequired, http.StatusBadRequest, "urn_key_required"},
		{count.ErrAllUndecryptable, http.StatusBadRequest, "all_ballots_undecryptable"},
		{count.ErrInvalidOptions, http.StatusUnprocessableEntity, "invalid_election_options"},
		{ballotclient.ErrUnavailable, http.StatusBadGateway, "ballot_unavailable"},
		{publisher.ErrUnavailable, http.StatusServiceUnavailable, "broker_unavailable"},
		{context.DeadlineExceeded, http.StatusGatewayTimeout, "upstream_timeout"},
		{errors.New("boom"), http.StatusInternalServerError, "internal_error"},
	}
	for _, test := range cases {
		handler := NewHandler(Config{Service: &fakeService{err: test.err}})
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/tally/elections/e1", nil))
		if recorder.Code != test.code || !strings.Contains(recorder.Body.String(), test.body) {
			t.Fatalf("%v: status = %d body=%s, want %d %s", test.err, recorder.Code, recorder.Body, test.code, test.body)
		}
	}
}

func TestInvalidElectionIDAndHealth(t *testing.T) {
	handler := NewHandler(Config{Service: &fakeService{}})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/tally/elections/e%2F1", nil))
	// The mux rejects the encoded slash before it reaches the handler.
	if recorder.Code != http.StatusNotFound && recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("healthz status = %d", recorder.Code)
	}
}

func TestReadinessReflectsDependencies(t *testing.T) {
	handler := NewHandler(Config{
		Service: &fakeService{},
		Ready:   func(context.Context) error { return errors.New("down") },
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz status = %d", recorder.Code)
	}
}
