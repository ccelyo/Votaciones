package server

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"
)

// MutualTLSConfig loads a server identity, trusts the supplied client CA, and
// restricts client certificates to the listed DNS identities.
func MutualTLSConfig(certFile, keyFile, caFile string, allowedClients ...string) (*tls.Config, error) {
	if certFile == "" && keyFile == "" && caFile == "" {
		return nil, nil
	}
	if certFile == "" || keyFile == "" || caFile == "" || len(allowedClients) == 0 {
		return nil, errors.New("mTLS requires a server certificate, key, client CA, and allowed client identities")
	}
	certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load TLS certificate: %w", err)
	}
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read TLS client CA: %w", err)
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("TLS client CA file contains no certificates")
	}
	allowed := make(map[string]struct{}, len(allowedClients))
	for _, name := range allowedClients {
		allowed[strings.TrimSpace(name)] = struct{}{}
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{certificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("client certificate is required")
			}
			for _, name := range state.PeerCertificates[0].DNSNames {
				if _, ok := allowed[name]; ok {
					return nil
				}
			}
			return errors.New("client certificate identity is not allowed")
		},
	}, nil
}
