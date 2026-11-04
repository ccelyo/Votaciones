"""E2E: crea urna, inscribe votante, emite token ciego, vota cifrado (RSA-OAEP+AES-GCM), cierra y escruta.

Uso (desde la raíz del repo, con el stack levantado):
    identity/.venv/bin/python docs/demo/e2e_vote.py [GATEWAY]
Deja la llave privada de la urna en docs/demo/urna.pem (no versionar).
"""
import base64, json, os, secrets, sys, time, urllib.request, urllib.error

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "identity", "tests"))
import rsabssa_client as rsabssa  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import padding, rsa  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

GW = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8088"
OUT = os.path.dirname(os.path.abspath(__file__))


def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def ub64u(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def call(method, path, body=None, token=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(GW + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(); code = r.status
    except urllib.error.HTTPError as e:
        raw = e.read(); code = e.code
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = raw.decode(errors="replace")
    print(f"{method} {path} -> {code}")
    return code, parsed


def login(user):
    _, c = call("POST", "/api/auth/login", {"username": user, "password": "prueba123"})
    _, t = call("POST", "/api/auth/login/mfa", {"challenge_id": c["challenge_id"], "code": "123456"})
    return t["access_token"]


admin = login("admin1")
voter = login("votante1")
_, me = call("GET", "/api/auth/me", token=voter)

urn = rsa.generate_private_key(public_exponent=65537, key_size=2048)
pem = urn.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
open(os.path.join(OUT, "urna.pem"), "w").write(pem)
spki = urn.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
options = ["candidata-1", "candidato-2", "voto-en-blanco"]
now = int(time.time())
code, el = call("POST", "/api/elections", {"name": f"E2E {now}", "options": options,
                "encryption_public_key": b64u(spki), "opens_at": now - 60, "closes_at": now + 3600, "open": True}, admin)
print(el)
eid = el["election_id"]
print(call("POST", f"/api/identity/elections/{eid}/voters", {"user_id": me["id"]}, admin))

_, params = call("GET", f"/api/ballots/elections/{eid}/parameters")
tk = params["token_keys"][0]
token_pub = serialization.load_der_public_key(ub64u(tk["public_key_der"]))

# 1-3. Cegar, firmar en identity, descegar.
nonce = secrets.token_bytes(32)
msg = rsabssa.TOKEN_DOMAIN + len(eid.encode()).to_bytes(2, "big") + eid.encode() + nonce
prepared = secrets.token_bytes(32) + msg
blinded, inv = rsabssa.blind(token_pub, prepared)
code, bs = call("POST", "/api/identity/tokens/blind", {"election_id": eid, "blinded_token": b64u(blinded)}, voter)
print(bs if code != 200 else {"kid": bs["kid"], "variant": bs["variant"]})
sig = rsabssa.finalize(token_pub, prepared, ub64u(bs["blind_signature"]), inv)
envelope = b64u(json.dumps({"v": 1, "kid": bs["kid"], "election_id": eid, "nonce": b64u(nonce),
                            "prepared_message": b64u(prepared), "signature": b64u(sig)}, separators=(",", ":")).encode())

# 4. Cifrar voto con la pública de la urna (sobre híbrido JSON que abre Tally).
urn_pub = serialization.load_der_public_key(ub64u(params["encryption_public_key"]))
aes = AESGCM.generate_key(256); n12 = secrets.token_bytes(12)
wrapped = urn_pub.encrypt(aes, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
ct = json.dumps({"alg": "RSA-OAEP-256+A256GCM", "key": b64u(wrapped), "nonce": b64u(n12),
                 "ciphertext": b64u(AESGCM(aes).encrypt(n12, b"candidata-1", None))}).encode()

# 5. Envío anónimo (sin Authorization).
ballot = {"election_id": eid, "token": envelope, "encrypted_vote": b64u(ct), "proof": b64u(b"stub-benaloh-proof")}
print(call("POST", "/api/ballots", ballot))
print("replay:", call("POST", "/api/ballots", ballot)[0])

# 6. Cerrar y escrutar con la privada.
print(call("POST", f"/api/elections/{eid}/close", None, admin)[0])
print(call("POST", f"/api/tally/elections/{eid}", {"private_key": pem}, admin))
print(call("POST", f"/api/tally/elections/{eid}", {"private_key": pem}, admin))
print(call("GET", f"/api/tally/elections/{eid}", token=voter))
print("ELECTION_ID", eid)
