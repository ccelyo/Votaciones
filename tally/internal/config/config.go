// Package config loads Tally's environment configuration.
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHTTPAddr        = ":8092"
	defaultBallotURL       = "http://localhost:8080"
	defaultRabbitMQURI     = "amqp://guest:guest@localhost:5672/"
	defaultExchange        = "tally.events"
	defaultHTTPTimeout     = 30 * time.Second
	defaultPublishAttempts = 5
)

// Config is the immutable configuration of the Tally service.
type Config struct {
	HTTPAddr          string
	TLSRequired       bool
	TLSCertFile       string
	TLSKeyFile        string
	TLSClientCAFile   string
	BallotTLSCAFile   string
	BallotTLSCertFile string
	BallotTLSKeyFile  string
	BallotURL         string
	BallotToken       string
	RabbitMQURI       string
	Exchange          string
	PrivateKey        []byte
	AllowPlaintext    bool
	HTTPTimeout       time.Duration
	PublishAttempts   int
}

// Load reads the configuration from the environment. Missing optional values
// fall back to development defaults; invalid values are rejected at startup.
func Load() (Config, error) {
	tlsRequired, err := boolEnv("TALLY_TLS_REQUIRED", false)
	if err != nil {
		return Config{}, err
	}
	allowPlaintext, err := boolEnv("TALLY_ALLOW_PLAINTEXT", true)
	if err != nil {
		return Config{}, err
	}
	httpTimeout, err := durationEnv("TALLY_HTTP_TIMEOUT", defaultHTTPTimeout)
	if err != nil {
		return Config{}, err
	}
	publishAttempts, err := intEnv("TALLY_PUBLISH_ATTEMPTS", defaultPublishAttempts)
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		HTTPAddr:          envOr("TALLY_HTTP_ADDR", defaultHTTPAddr),
		TLSRequired:       tlsRequired,
		TLSCertFile:       strings.TrimSpace(os.Getenv("TALLY_TLS_CERT_FILE")),
		TLSKeyFile:        strings.TrimSpace(os.Getenv("TALLY_TLS_KEY_FILE")),
		TLSClientCAFile:   strings.TrimSpace(os.Getenv("TALLY_TLS_CLIENT_CA_FILE")),
		BallotTLSCAFile:   strings.TrimSpace(os.Getenv("BALLOT_TLS_CA_FILE")),
		BallotTLSCertFile: strings.TrimSpace(os.Getenv("BALLOT_TLS_CERT_FILE")),
		BallotTLSKeyFile:  strings.TrimSpace(os.Getenv("BALLOT_TLS_KEY_FILE")),
		BallotURL:         strings.TrimRight(envOr("BALLOT_URL", defaultBallotURL), "/"),
		BallotToken:       strings.TrimSpace(os.Getenv("TALLY_BALLOT_TOKEN")),
		RabbitMQURI:       envOr("TALLY_RABBITMQ_URI", envOr("RABBITMQ_URI", defaultRabbitMQURI)),
		Exchange:          envOr("TALLY_EXCHANGE", defaultExchange),
		AllowPlaintext:    allowPlaintext,
		HTTPTimeout:       httpTimeout,
		PublishAttempts:   publishAttempts,
	}

	parsed, err := url.Parse(cfg.BallotURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return Config{}, fmt.Errorf("BALLOT_URL must be an absolute http(s) URL, got %q", cfg.BallotURL)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return Config{}, fmt.Errorf("BALLOT_URL must use http or https, got %q", parsed.Scheme)
	}
	if cfg.TLSRequired {
		if cfg.TLSCertFile == "" || cfg.TLSKeyFile == "" || cfg.TLSClientCAFile == "" {
			return Config{}, fmt.Errorf("TALLY_TLS_REQUIRED needs TLS_CERT_FILE, TLS_KEY_FILE and TLS_CLIENT_CA_FILE")
		}
		if cfg.BallotTLSCAFile == "" || cfg.BallotTLSCertFile == "" || cfg.BallotTLSKeyFile == "" {
			return Config{}, fmt.Errorf("TALLY_TLS_REQUIRED needs BALLOT_TLS_CA_FILE, BALLOT_TLS_CERT_FILE and BALLOT_TLS_KEY_FILE")
		}
		if parsed.Scheme != "https" {
			return Config{}, fmt.Errorf("TALLY_TLS_REQUIRED requires BALLOT_URL to use https")
		}
	}
	if cfg.HTTPTimeout <= 0 {
		return Config{}, fmt.Errorf("TALLY_HTTP_TIMEOUT must be positive")
	}
	if cfg.PublishAttempts < 1 {
		return Config{}, fmt.Errorf("TALLY_PUBLISH_ATTEMPTS must be at least 1")
	}

	if raw, err := keyMaterial(); err != nil {
		return Config{}, err
	} else {
		cfg.PrivateKey = raw
	}
	return cfg, nil
}

// keyMaterial returns the optional default urn private key. TALLY_PRIVATE_KEY
// takes precedence over TALLY_PRIVATE_KEY_FILE. The content may be PEM, DER or
// base64 of either; validation happens when the decryptor is built.
func keyMaterial() ([]byte, error) {
	if raw := strings.TrimSpace(os.Getenv("TALLY_PRIVATE_KEY")); raw != "" {
		return []byte(raw), nil
	}
	path := strings.TrimSpace(os.Getenv("TALLY_PRIVATE_KEY_FILE"))
	if path == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read TALLY_PRIVATE_KEY_FILE: %w", err)
	}
	return raw, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func boolEnv(name string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean: %w", name, err)
	}
	return value, nil
}

func intEnv(name string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}
	return value, nil
}

func durationEnv(name string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be a Go duration (e.g. 30s): %w", name, err)
	}
	return value, nil
}
