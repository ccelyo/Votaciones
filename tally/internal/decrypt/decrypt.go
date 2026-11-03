// Package decrypt opens the ballots stored by Ballot.
//
// Two encodings are supported:
//
//   - Plaintext (Prototype 1): the ciphertext is the chosen option in UTF-8.
//     It stays anonymous because the token is unlinkable, but it is not real
//     encryption and is disabled with TALLY_ALLOW_PLAINTEXT=false.
//   - Hybrid RSA-OAEP-256 + AES-256-GCM: a random AES key is wrapped with the
//     urn public key and the option is encrypted with AES-GCM.
//
// The hybrid envelope is either JSON
//
//	{"alg":"RSA-OAEP-256+A256GCM","key":"<b64url>","nonce":"<b64url>","ciphertext":"<b64url>"}
//
// or the compact binary form
//
//	uint16 key_len (big endian) || wrapped_key || nonce(12) || ciphertext+GCM tag
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
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

var (
	// ErrPrivateKeyRequired means the ballot is encrypted and no urn key was
	// supplied to Tally.
	ErrPrivateKeyRequired = errors.New("urn private key is required to decrypt ballots")
	// ErrInvalidPrivateKey means the material is not a usable RSA private key.
	ErrInvalidPrivateKey = errors.New("invalid urn private key")
	// ErrUndecryptable means the envelope is malformed or the key does not open
	// it. The ballot is counted as invalid.
	ErrUndecryptable = errors.New("ballot cannot be decrypted")
)

const (
	algHybrid    = "RSA-OAEP-256+A256GCM"
	gcmNonceSize = 12
	gcmTagSize   = 16
	maxPlaintext = 4096
)

// Decryptor decrypts one ballot at a time.
type Decryptor struct {
	key            *rsa.PrivateKey
	allowPlaintext bool
}

// New parses the optional private key. Empty material is valid: the decryptor
// then only opens plaintext ballots when allowPlaintext is true, and returns
// ErrPrivateKeyRequired for encrypted ones (the key can arrive per launch).
func New(material []byte, allowPlaintext bool) (*Decryptor, error) {
	key, err := ParsePrivateKey(material)
	if err != nil {
		return nil, err
	}
	return &Decryptor{key: key, allowPlaintext: allowPlaintext}, nil
}

// HasKey reports whether a default urn key is configured.
func (d *Decryptor) HasKey() bool { return d != nil && d.key != nil }

// PublicKeyDER returns the PKIX encoding of the configured key, if any. It is
// compared with the election's encryption_public_key as a key sanity check.
func (d *Decryptor) PublicKeyDER() []byte {
	if d == nil || d.key == nil {
		return nil
	}
	der, err := x509.MarshalPKIXPublicKey(&d.key.PublicKey)
	if err != nil {
		return nil
	}
	return der
}

// MatchesPublicKey reports whether der is the public half of the configured
// key. comparable is false when der is absent or not a parseable public key
// (for example, the opaque placeholder used during Prototype 1); in that case
// the caller may proceed but should record that the key was not verified.
func (d *Decryptor) MatchesPublicKey(der []byte) (match, comparable bool) {
	if d == nil || d.key == nil || len(der) == 0 {
		return false, false
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		pkcs1, pkcs1Err := x509.ParsePKCS1PublicKey(der)
		if pkcs1Err != nil {
			return false, false
		}
		parsed = pkcs1
	}
	public, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return false, true
	}
	return public.Equal(&d.key.PublicKey), true
}

// Decrypt returns the option encoded in a ballot.
func (d *Decryptor) Decrypt(ciphertext []byte) (string, error) {
	if len(ciphertext) == 0 {
		return "", fmt.Errorf("%w: empty ballot", ErrUndecryptable)
	}
	if looksHyphenHybrid(ciphertext) {
		if d == nil || d.key == nil {
			return "", ErrPrivateKeyRequired
		}
		return d.openHybrid(ciphertext)
	}
	if d != nil && d.allowPlaintext && utf8.Valid(ciphertext) && len(ciphertext) <= maxPlaintext {
		if hasControl(ciphertext) {
			return "", fmt.Errorf("%w: plaintext ballot contains control characters", ErrUndecryptable)
		}
		return string(ciphertext), nil
	}
	if d != nil && d.key != nil && utf8.Valid(ciphertext) && len(ciphertext) <= maxPlaintext {
		// A short binary envelope is impossible; treat it as an encrypted
		// ballot the key could not open rather than as plaintext.
		return "", fmt.Errorf("%w: unrecognized ballot encoding", ErrUndecryptable)
	}
	return "", fmt.Errorf("%w: unrecognized ballot encoding", ErrUndecryptable)
}

func (d *Decryptor) openHybrid(ciphertext []byte) (string, error) {
	var (
		wrapped []byte
		nonce   []byte
		payload []byte
	)
	if isJSONObject(ciphertext) {
		var envelope struct {
			Algorithm  string `json:"alg"`
			Key        string `json:"key"`
			Nonce      string `json:"nonce"`
			Ciphertext string `json:"ciphertext"`
		}
		if err := json.Unmarshal(ciphertext, &envelope); err != nil {
			return "", fmt.Errorf("%w: invalid JSON envelope: %v", ErrUndecryptable, err)
		}
		if envelope.Algorithm != algHybrid {
			return "", fmt.Errorf("%w: unsupported algorithm %q", ErrUndecryptable, envelope.Algorithm)
		}
		var err error
		if wrapped, err = decodeBase64(envelope.Key); err != nil {
			return "", fmt.Errorf("%w: invalid wrapped key: %v", ErrUndecryptable, err)
		}
		if nonce, err = decodeBase64(envelope.Nonce); err != nil {
			return "", fmt.Errorf("%w: invalid nonce: %v", ErrUndecryptable, err)
		}
		if payload, err = decodeBase64(envelope.Ciphertext); err != nil {
			return "", fmt.Errorf("%w: invalid ciphertext: %v", ErrUndecryptable, err)
		}
	} else {
		if len(ciphertext) < 2+gcmNonceSize+gcmTagSize {
			return "", fmt.Errorf("%w: binary envelope is too short", ErrUndecryptable)
		}
		keyLen := int(binary.BigEndian.Uint16(ciphertext[:2]))
		if keyLen != d.key.Size() || len(ciphertext) < 2+keyLen+gcmNonceSize+gcmTagSize {
			return "", fmt.Errorf("%w: binary envelope has an invalid key length", ErrUndecryptable)
		}
		wrapped = ciphertext[2 : 2+keyLen]
		nonce = ciphertext[2+keyLen : 2+keyLen+gcmNonceSize]
		payload = ciphertext[2+keyLen+gcmNonceSize:]
	}

	aesKey, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, d.key, wrapped, nil)
	if err != nil {
		return "", fmt.Errorf("%w: unwrap AES key: %v", ErrUndecryptable, err)
	}
	if len(aesKey) != 32 {
		return "", fmt.Errorf("%w: wrapped key is not AES-256", ErrUndecryptable)
	}
	if len(nonce) != gcmNonceSize || len(payload) < gcmTagSize {
		return "", fmt.Errorf("%w: invalid nonce or payload", ErrUndecryptable)
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUndecryptable, err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUndecryptable, err)
	}
	plaintext, err := aead.Open(nil, nonce, payload, nil)
	if err != nil {
		return "", fmt.Errorf("%w: open AES-GCM: %v", ErrUndecryptable, err)
	}
	if !utf8.Valid(plaintext) || len(plaintext) > maxPlaintext {
		return "", fmt.Errorf("%w: decrypted ballot is not a valid option", ErrUndecryptable)
	}
	return string(plaintext), nil
}

// ParsePrivateKey accepts PEM (PKCS#1 or PKCS#8), DER, or base64 of either.
func ParsePrivateKey(material []byte) (*rsa.PrivateKey, error) {
	trimmed := strings.TrimSpace(string(material))
	if trimmed == "" {
		return nil, nil
	}
	raw := []byte(trimmed)
	if !strings.Contains(trimmed, "-----BEGIN") && !bytesLookLikeDER(raw) {
		decoded, err := decodeBase64(trimmed)
		if err != nil {
			return nil, fmt.Errorf("%w: not PEM, DER or base64: %v", ErrInvalidPrivateKey, err)
		}
		raw = decoded
	}
	if block, _ := pem.Decode(raw); block != nil {
		raw = block.Bytes
	}
	if parsed, err := x509.ParsePKCS8PrivateKey(raw); err == nil {
		key, ok := parsed.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("%w: key is not RSA", ErrInvalidPrivateKey)
		}
		if err := key.Validate(); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidPrivateKey, err)
		}
		return key, nil
	}
	key, err := x509.ParsePKCS1PrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidPrivateKey, err)
	}
	if err := key.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidPrivateKey, err)
	}
	return key, nil
}

func looksHyphenHybrid(ciphertext []byte) bool {
	if isJSONObject(ciphertext) {
		return true
	}
	if len(ciphertext) < 2+gcmNonceSize+gcmTagSize {
		return false
	}
	// A compact envelope starts with the wrapped-key length (256 or 512 bytes
	// for the RSA keys used here) and contains binary data. Plaintext options
	// are short UTF-8 strings, so they never match both conditions.
	keyLen := int(binary.BigEndian.Uint16(ciphertext[:2]))
	return keyLen >= 128 && isProbablyBinary(ciphertext)
}

func isJSONObject(ciphertext []byte) bool {
	trimmed := strings.TrimSpace(string(ciphertext))
	return strings.HasPrefix(trimmed, "{") && strings.Contains(trimmed, `"alg"`) && strings.Contains(trimmed, `"ciphertext"`)
}

func isProbablyBinary(ciphertext []byte) bool {
	for _, b := range ciphertext {
		if b == 0 || b < 0x09 || (b > 0x0d && b < 0x20) {
			return true
		}
	}
	return false
}

func hasControl(ciphertext []byte) bool {
	for _, b := range ciphertext {
		if b < 0x09 || (b > 0x0d && b < 0x20) {
			return true
		}
	}
	return false
}

func bytesLookLikeDER(raw []byte) bool {
	return len(raw) > 2 && raw[0] == 0x30
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
