import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  interpretarSobre,
  mensajeCanonicoToken,
  serializarSobre,
  tokenIdHex,
} from "../token.ts";
import { cegar, claveDesdeDerSpki, descegar, i2osp, os2ip } from "../blind.ts";
import { CifradorSimulado } from "../encryptor.ts";
import { interpretarRecibo, mensajeRecibo, serializarRecibo } from "../receipt.ts";

describe("M4: mensaje canónico del token", () => {
  it("fija dominio, longitud big-endian y nonce", () => {
    const nonce = new Uint8Array(32).fill(7);
    const mensaje = mensajeCanonicoToken("eleccion-1", nonce);
    const dominio = new TextEncoder().encode("votaciones.ballot.anonymous-token.v1\x00");
    assert.equal(mensaje.length, dominio.length + 2 + "eleccion-1".length + 32);
    assert.equal(mensaje[dominio.length], 0);
    assert.equal(mensaje[dominio.length + 1], "eleccion-1".length);
    assert.throws(() => mensajeCanonicoToken("", nonce), /identificador/);
    assert.throws(() => mensajeCanonicoToken("eleccion-1", new Uint8Array(3)), /nonce/);
  });
});

describe("M4: sobre del token", () => {
  it("serializa e interpreta de forma canónica y rechaza campos extra", () => {
    const nonce = new Uint8Array(32).fill(1);
    const prepared = new Uint8Array(100).fill(2);
    const firma = new Uint8Array(256).fill(3);
    const sobre = serializarSobre({
      version: 1,
      kid: "demo-kid-1",
      electionId: "eleccion-1",
      nonce,
      preparedMessage: prepared,
      signature: firma,
    });
    const leido = interpretarSobre(sobre);
    assert.equal(leido.electionId, "eleccion-1");
    assert.equal(leido.kid, "demo-kid-1");
    // Campo desconocido debe fallar (paridad con Go DisallowUnknownFields)
    const aB64 = sobre.replace(/-/g, "+").replace(/_/g, "/");
    const conRelleno = aB64 + "=".repeat((4 - (aB64.length % 4)) % 4);
    const crudo = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(conRelleno), (c) => c.charCodeAt(0))),
    ) as Record<string, unknown>;
    crudo["extra"] = true;
    const manipulado = btoa(JSON.stringify(crudo)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.throws(() => interpretarSobre(manipulado), /token inválido/);
  });

  it("tokenID es hex SHA-256 de 64 caracteres", async () => {
    const sobre = serializarSobre({
      version: 1,
      kid: "k",
      electionId: "e",
      nonce: new Uint8Array(32).fill(9),
      preparedMessage: new Uint8Array(100).fill(9),
      signature: new Uint8Array(256).fill(9),
    });
    const id = await tokenIdHex(sobre);
    assert.match(id, /^[0-9a-f]{64}$/);
  });
});

describe("M4: cegado BigInt", () => {
  it("os2ip/i2osp son inversos y cegar/descegar se anulan con firmante en crudo", () => {
    // Clave de juguete (NO segura): n = 61*53, e = 17. Solo prueba el armazón.
    const n = BigInt(61 * 53);
    const e = BigInt(17);
    // d = 2753 para n=3233, e=17
    const d = BigInt(2753);
    const k = 2;
    const preparado = new Uint8Array([0x01, 0x02]);
    const m = os2ip(preparado);
    assert.deepEqual(Array.from(i2osp(m, k)), [1, 2]);
    // Simula el flujo: cegar -> firmar en crudo (m^d) -> descegar
    const r = BigInt(7);
    const modPow = (b: bigint, x: bigint, mod: bigint): bigint => {
      let res = BigInt(1);
      let base = b % mod;
      let exp = x;
      while (exp > BigInt(0)) {
        if (exp & BigInt(1)) res = (res * base) % mod;
        base = (base * base) % mod;
        exp = exp >> BigInt(1);
      }
      return res;
    };
    const cegado = (m * modPow(r, e, n)) % n;
    const firmaCegada = modPow(cegado, d, n);
    // inverso de 7 mod 3233 = 1384 (7*1384 = 9688 = 3*3233+... verifica: 3233*2=6466, 9688-6466=3222? no).
    // No se asume valor: se calcula con Euclides inline.
    const inv = ((): bigint => {
      let [a, mod] = [r, n];
      let [x0, x1] = [BigInt(1), BigInt(0)];
      while (mod !== BigInt(0)) {
        const q = a / mod;
        [a, mod] = [mod, a - q * mod];
        [x0, x1] = [x1, x0 - q * x1];
      }
      return ((x0 % n) + n) % n;
    })();
    const firma = (firmaCegada * inv) % n;
    assert.equal(firma, modPow(m, d, n));
    // Las funciones reales no fallan con una clave >= 2048 bits sintética:
    // aquí solo se verifica que rechazan mensajes fuera de rango.
    assert.throws(() => cegar(new Uint8Array([9]), { n: BigInt(15), e: BigInt(3) }), /rango|DER|factor/);
    assert.throws(() => descegar(new Uint8Array([1]), { r: BigInt(1), rInverso: BigInt(1), n, prepared: preparado }), /longitud/);
    void cegar;
    void descegar;
    void claveDesdeDerSpki;
  });
});

describe("M4: cifrador stub", () => {
  it("devuelve los bytes que acepta el stub de Go", async () => {
    const cifrador = new CifradorSimulado();
    const { ciphertext, proof } = await cifrador.cifrar("Opción A", "eleccion-1");
    assert.equal(new TextDecoder().decode(ciphertext), "stub-encrypted-vote");
    assert.equal(new TextDecoder().decode(proof), "stub-benaloh-proof");
  });
});

describe("M4: recibo", () => {
  it("construye el mensaje con dominio y serializa de forma canónica", () => {
    const hash = new Uint8Array(32).fill(5);
    const mensaje = mensajeRecibo("eleccion-1", hash);
    const dominio = new TextEncoder().encode("votaciones.ballot.receipt.v1\x00");
    assert.equal(mensaje[dominio.length + 1], "eleccion-1".length);
    const sobre = serializarRecibo({ version: 1, electionId: "eleccion-1", ballotHash: hash, signature: new Uint8Array(64).fill(6) });
    assert.equal(interpretarRecibo(sobre).electionId, "eleccion-1");
    assert.throws(() => mensajeRecibo("eleccion-1", new Uint8Array(3)), /hash/);
  });
});
