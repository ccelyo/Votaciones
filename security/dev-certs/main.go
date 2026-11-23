package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

type service struct {
	name      string
	dnsNames []string
	ips      []net.IP
}

var services = []service{
	{name: "waf", dnsNames: []string{"waf", "localhost"}, ips: []net.IP{net.ParseIP("127.0.0.1")}},
	{name: "platform", dnsNames: []string{"platform", "localhost"}, ips: []net.IP{net.ParseIP("127.0.0.1")}},
	{name: "gateway", dnsNames: []string{"gateway", "localhost"}, ips: []net.IP{net.ParseIP("127.0.0.1")}},
	{name: "identity", dnsNames: []string{"identity", "localhost"}, ips: []net.IP{net.ParseIP("127.0.0.1")}},
	{name: "election", dnsNames: []string{"election", "localhost"}, ips: []net.IP{net.ParseIP("127.0.0.1")}},
	{name: "ballot", dnsNames: []string{"ballot", "localhost"}, ips: []net.IP{net.ParseIP("127.0.0.1")}},
	{name: "tally", dnsNames: []string{"tally", "localhost"}, ips: []net.IP{net.ParseIP("127.0.0.1")}},
	{name: "analytics", dnsNames: []string{"analytics", "localhost"}, ips: []net.IP{net.ParseIP("127.0.0.1")}},
	{name: "notification", dnsNames: []string{"notification", "localhost"}, ips: []net.IP{net.ParseIP("127.0.0.1")}},
}

func main() {
	if err := generate(os.Getenv("CERTS_OUTPUT_DIR")); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func generate(root string) error {
	if root == "" {
		root = "/certs"
	}
	caCert, caKey, err := loadOrCreateCA(root)
	if err != nil {
		return err
	}
	for _, item := range services {
		if err := ensureLeaf(root, item, caCert, caKey); err != nil {
			return fmt.Errorf("create %s development certificate: %w", item.name, err)
		}
	}
	return nil
}

func loadOrCreateCA(root string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	certPath := filepath.Join(root, "ca-public", "ca.crt")
	keyPath := filepath.Join(root, "ca-private", "ca.key")
	if _, err := os.Stat(certPath); err == nil {
		certPEM, err := os.ReadFile(certPath)
		if err != nil {
			return nil, nil, err
		}
		keyPEM, err := os.ReadFile(keyPath)
		if err != nil {
			return nil, nil, err
		}
		certBlock, _ := pem.Decode(certPEM)
		keyBlock, _ := pem.Decode(keyPEM)
		if certBlock == nil || keyBlock == nil {
			return nil, nil, errors.New("invalid development CA PEM files")
		}
		cert, err := x509.ParseCertificate(certBlock.Bytes)
		if err != nil {
			return nil, nil, err
		}
		key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
		if err != nil {
			return nil, nil, err
		}
		return cert, key, nil
	} else if !os.IsNotExist(err) {
		return nil, nil, err
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Votaciones local development CA"},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.AddDate(5, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:             0,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	if err := writePEM(certPath, "CERTIFICATE", der, 0o644); err != nil {
		return nil, nil, err
	}
	if err := writePEM(keyPath, "EC PRIVATE KEY", keyDER, 0o600); err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

func ensureLeaf(root string, item service, caCert *x509.Certificate, caKey *ecdsa.PrivateKey) error {
	certPath := filepath.Join(root, item.name, "tls.crt")
	keyPath := filepath.Join(root, item.name, "tls.key")
	if _, err := os.Stat(certPath); err == nil {
		if _, keyErr := os.Stat(keyPath); keyErr != nil {
			return keyErr
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := randomSerial()
	if err != nil {
		return err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: item.name},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.AddDate(1, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:     item.dnsNames,
		IPAddresses:  item.ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, caCert, &key.PublicKey, caKey)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	if err := writePEM(certPath, "CERTIFICATE", der, 0o644); err != nil {
		return err
	}
	return writePEM(keyPath, "EC PRIVATE KEY", keyDER, 0o644)
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}

func writePEM(path, kind string, der []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), mode)
}
