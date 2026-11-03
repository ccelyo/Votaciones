// Package ballotclient is the REST client Tally uses to read a closed urn from
// Ballot. It only needs the public election parameters and the encrypted
// ballots: no token, receipt or voter data is ever requested.
package ballotclient

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	// ErrElectionNotFound means Ballot does not know the election.
	ErrElectionNotFound = errors.New("election not found")
	// ErrElectionNotClosed means the urn is still open or was never closed.
	ErrElectionNotClosed = errors.New("election not closed")
	// ErrUnavailable means Ballot could not be reached or answered 5xx.
	ErrUnavailable = errors.New("ballot unavailable")
)

const (
	maxParametersBytes = 1 << 20
	maxBallotsBytes    = 128 << 20
	defaultAttempts    = 3
)

// Parameters is the public, signed description of an election.
type Parameters struct {
	ElectionID          string   `json:"election_id"`
	Status              string   `json:"status"`
	Options             []string `json:"options"`
	EncryptionPublicKey string   `json:"encryption_public_key"`
}

// PublicKeyDER decodes the election's encryption public key. It is empty when
// Ballot does not publish one.
func (p Parameters) PublicKeyDER() ([]byte, error) {
	if strings.TrimSpace(p.EncryptionPublicKey) == "" {
		return nil, nil
	}
	return decodeBase64(p.EncryptionPublicKey)
}

// Client talks to Ballot over HTTP.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// New builds a client. token is an optional bearer shared with Ballot to keep
// the ballot dump off the public internet.
func New(baseURL, token string, timeout time.Duration) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: timeout},
	}
}

// Parameters returns the options of an election.
func (c *Client) Parameters(ctx context.Context, electionID string) (Parameters, error) {
	if err := validateElectionID(electionID); err != nil {
		return Parameters{}, err
	}
	var params Parameters
	if err := c.getJSON(ctx, "/v1/elections/"+url.PathEscape(electionID)+"/parameters", maxParametersBytes, &params); err != nil {
		return Parameters{}, err
	}
	if len(params.Options) == 0 {
		return Parameters{}, fmt.Errorf("ballot returned no options for election %q", electionID)
	}
	return params, nil
}

// Ballots returns the encrypted ballots of a closed urn. The endpoint returns
// 409 while the urn is open, so Tally never counts a partial election.
func (c *Client) Ballots(ctx context.Context, electionID string) ([][]byte, error) {
	if err := validateElectionID(electionID); err != nil {
		return nil, err
	}
	var response struct {
		Ballots []string `json:"ballots"`
	}
	if err := c.getJSON(ctx, "/v1/elections/"+url.PathEscape(electionID)+"/ballots", maxBallotsBytes, &response); err != nil {
		return nil, err
	}
	ballots := make([][]byte, len(response.Ballots))
	for i, encoded := range response.Ballots {
		decoded, err := decodeBase64(encoded)
		if err != nil {
			return nil, fmt.Errorf("ballot %d is not valid base64url: %w", i, err)
		}
		ballots[i] = decoded
	}
	return ballots, nil
}

// Health checks that Ballot is reachable. It is used by /readyz.
func (c *Client) Health(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/healthz", nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: health status %d", ErrUnavailable, response.StatusCode)
	}
	return nil
}

func (c *Client) getJSON(ctx context.Context, path string, limit int64, target any) error {
	var lastErr error
	for attempt := 0; attempt < defaultAttempts; attempt++ {
		if attempt > 0 {
			if err := sleep(ctx, time.Duration(200<<attempt)*time.Millisecond); err != nil {
				return err
			}
		}
		status, body, err := c.get(ctx, path, limit)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			lastErr = fmt.Errorf("%w: %v", ErrUnavailable, err)
			continue
		}
		switch {
		case status == http.StatusOK:
			if err := json.Unmarshal(body, target); err != nil {
				return fmt.Errorf("decode ballot response: %w", err)
			}
			return nil
		case status == http.StatusNotFound:
			return ErrElectionNotFound
		case status == http.StatusConflict:
			return ErrElectionNotClosed
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			return fmt.Errorf("%w: ballot rejected the internal token (status %d)", ErrUnavailable, status)
		case status == http.StatusTooManyRequests || status >= http.StatusInternalServerError:
			lastErr = fmt.Errorf("%w: status %d", ErrUnavailable, status)
			continue
		default:
			return fmt.Errorf("ballot returned unexpected status %d: %s", status, snippet(body))
		}
	}
	if lastErr == nil {
		lastErr = ErrUnavailable
	}
	return lastErr
}

func (c *Client) get(ctx context.Context, path string, limit int64) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Accept", "application/json")
	if c.token != "" {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, limit))
	if err != nil {
		return 0, nil, err
	}
	if int64(len(body)) >= limit {
		return 0, nil, errors.New("ballot response exceeds the size limit")
	}
	return response.StatusCode, body, nil
}

func validateElectionID(electionID string) error {
	if strings.TrimSpace(electionID) == "" || strings.ContainsAny(electionID, "/?#") {
		return errors.New("invalid election id")
	}
	return nil
}

func decodeBase64(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	encodings := []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.RawStdEncoding,
		base64.StdEncoding,
	}
	var lastErr error
	for _, encoding := range encodings {
		decoded, err := encoding.DecodeString(value)
		if err == nil {
			return decoded, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func snippet(body []byte) string {
	body = bytes.TrimSpace(body)
	if len(body) > 200 {
		body = body[:200]
	}
	return string(body)
}
