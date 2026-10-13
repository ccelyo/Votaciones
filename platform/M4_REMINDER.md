# M4 Reminder — revisit vote encryption before Prototype 2

- Current Go `ballot/` does **only accept opaque ciphertext + stub proof**.
  Proof: `internal/server/happy_path_test.go:19-26` stub requires `proof == "stub-benaloh-proof"`, ciphertext is `[]byte("stub-encrypted-vote")`.
  Contract: `internal/ballot/acceptor.go:52-56` defines `ProofVerifier interface{ Verify(...) }` with comment "Production proof verification remains a separately agreed M7 contract".
  Election key: `internal/election/store.go:37` stores `EncryptionPublicKey []byte` opaque, never parsed.
- Update: P1 now stores the chosen option as plain UTF-8 in `encrypted_vote` (`CifradorTextoPlano`) so `GET /v1/elections/{id}/results` can tally closed elections (`ballot/internal/ballot/tally.go`). Ballots stay anonymous (blind token, no voter data). P2 must replace both the encoding and the plain tally with ElGamal + homomorphic decryption of the total.
- M4 decision for P1: use stub encryptor behind `Encryptor` interface so real ElGamal + OR-proof can replace it without touching UI or `POST /ballots` caller.
- TODO before P2: choose Exp. ElGamal curve (ed25519 vs P-256), ciphertext encoding, proof system (Chaum-Pedersen OR-proof), agree `Verify()` + size limits (`maxEncryptedBytes=1MiB`, `maxProofBytes=256KiB` in `internal/ballot/hash.go:19-23`) with M7/M8.
