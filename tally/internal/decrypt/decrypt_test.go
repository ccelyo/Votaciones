package decrypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"testing"
)

func TestPlaintextBallots(t *testing.T) {
	decryptor, err := New(nil, true)
	if err != nil {
		t.Fatal(err)
	}
	option, err := decryptor.Decrypt([]byte("candidato-1"))
	if err != nil || option != "candidato-1" {
		t.Fatalf("decrypt = %q, %v", option, err)
	}

	strict, err := New(nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := strict.Decrypt([]byte("candidato-1")); !errors.Is(err, ErrUndecryptable) {
		t.Fatalf("plaintext with encryption required: %v", err)
	}
}

func TestHybridJSONAndBinary(t *testing.T) {
	key := mustKey(t)
	public := &key.PublicKey
	decryptor, err := New(pemFor(t, key), false)
	if err != nil {
		t.Fatal(err)
	}
	jsonBallot := sealJSON(t, public, []byte("candidato-2"))
	binaryBallot := sealBinary(t, public, []byte("candidato-3"))

	for name, ballot := range map[string][]byte{"json": jsonBallot, "binary": binaryBallot} {
		option, err := decryptor.Decrypt(ballot)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want := map[string]string{"json": "candidato-2", "binary": "candidato-3"}[name]
		if option != want {
			t.Fatalf("%s: option = %q, want %q", name, option, want)
		}
	}
}

func TestEncryptedBallotWithoutKeyNeedsKey(t *testing.T) {
	key := mustKey(t)
	ballot := sealJSON(t, &key.PublicKey, []byte("candidato-1"))
	decryptor, err := New(nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptor.Decrypt(ballot); !errors.Is(err, ErrPrivateKeyRequired) {
		t.Fatalf("error = %v, want ErrPrivateKeyRequired", err)
	}
}

func TestWrongKeyIsUndecryptable(t *testing.T) {
	key := mustKey(t)
	other := mustKey(t)
	ballot := sealJSON(t, &key.PublicKey, []byte("candidato-1"))
	decryptor, err := New(pemFor(t, other), false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptor.Decrypt(ballot); !errors.Is(err, ErrUndecryptable) {
		t.Fatalf("error = %v, want ErrUndecryptable", err)
	}
}

func TestParsePrivateKeyFormats(t *testing.T) {
	key := mustKey(t)
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pkcs1 := x509.MarshalPKCS1PrivateKey(key)
	materials := map[string][]byte{
		"pem-pkcs8":    pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}),
		"pem-pkcs1":    pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: pkcs1}),
		"der-pkcs8":    pkcs8,
		"der-pkcs1":    pkcs1,
		"b64-pkcs8":    []byte(base64.StdEncoding.EncodeToString(pkcs8)),
		"b64url-pkcs1": []byte(base64.RawURLEncoding.EncodeToString(pkcs1)),
	}
	for name, material := range materials {
		parsed, err := ParsePrivateKey(material)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !parsed.Equal(key) {
			t.Fatalf("%s: parsed a different key", name)
		}
	}
	if _, err := ParsePrivateKey([]byte("not a key")); !errors.Is(err, ErrInvalidPrivateKey) {
		t.Fatalf("garbage key error = %v", err)
	}
}

func TestMatchesPublicKey(t *testing.T) {
	key := mustKey(t)
	decryptor, _ := New(pemFor(t, key), false)
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if match, comparable := decryptor.MatchesPublicKey(der); !match || !comparable {
		t.Fatalf("match=%v comparable=%v", match, comparable)
	}
	other := mustKey(t)
	otherDER, _ := x509.MarshalPKIXPublicKey(&other.PublicKey)
	if match, comparable := decryptor.MatchesPublicKey(otherDER); match || !comparable {
		t.Fatalf("other key match=%v comparable=%v", match, comparable)
	}
	pkcs1DER := x509.MarshalPKCS1PublicKey(&key.PublicKey)
	if match, comparable := decryptor.MatchesPublicKey(pkcs1DER); !match || !comparable {
		t.Fatalf("pkcs1 key match=%v comparable=%v", match, comparable)
	}
	if _, comparable := decryptor.MatchesPublicKey([]byte("opaque")); comparable {
		t.Fatal("opaque key must not be comparable")
	}
}

func mustKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func pemFor(t *testing.T, key *rsa.PrivateKey) []byte {
	t.Helper()
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})
}

func sealJSON(t *testing.T, public *rsa.PublicKey, plaintext []byte) []byte {
	t.Helper()
	wrapped, nonce, payload := sealParts(t, public, plaintext)
	return []byte(`{"alg":"` + algHybrid + `","key":"` +
		base64.RawURLEncoding.EncodeToString(wrapped) + `","nonce":"` +
		base64.RawURLEncoding.EncodeToString(nonce) + `","ciphertext":"` +
		base64.RawURLEncoding.EncodeToString(payload) + `"}`)
}

func sealBinary(t *testing.T, public *rsa.PublicKey, plaintext []byte) []byte {
	t.Helper()
	wrapped, nonce, payload := sealParts(t, public, plaintext)
	envelope := make([]byte, 2+len(wrapped)+len(nonce)+len(payload))
	binary.BigEndian.PutUint16(envelope[:2], uint16(len(wrapped)))
	copy(envelope[2:], wrapped)
	copy(envelope[2+len(wrapped):], nonce)
	copy(envelope[2+len(wrapped)+len(nonce):], payload)
	return envelope
}

func sealParts(t *testing.T, public *rsa.PublicKey, plaintext []byte) (wrapped, nonce, payload []byte) {
	t.Helper()
	aesKey := make([]byte, 32)
	nonce = make([]byte, gcmNonceSize)
	if _, err := rand.Read(aesKey); err != nil {
		t.Fatal(err)
	}
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	payload = aead.Seal(nil, nonce, plaintext, nil)
	wrapped, err = rsa.EncryptOAEP(sha256.New(), rand.Reader, public, aesKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	return wrapped, nonce, payload
}
