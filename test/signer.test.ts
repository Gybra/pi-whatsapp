import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import test from "node:test";
import { createProof, createSessionSigner, destroySessionSigner } from "../src/approval.ts";
import { decodeDraft } from "../src/protocol.ts";
import { fixture, fixtureWire, keyFromSeed, RFC_TEST_SEED, textPayload, wireFor } from "./helpers.ts";

test("generates a fresh session key and exposes only public identity", () => {
  const a = createSessionSigner();
  const b = createSessionSigner();
  assert.notEqual(a.publicKeyB64, b.publicKeyB64);
  const raw = Buffer.from(a.publicKeyB64, "base64");
  assert.equal(raw.length, 32);
  assert.equal(a.approverID, createHash("sha256").update(raw).digest("hex"));
  assert.deepEqual(JSON.parse(JSON.stringify(a)), { publicKeyB64: a.publicKeyB64, approverID: a.approverID });
  for (const value of Object.values(a)) {
    assert.notEqual(typeof value, "object", "no key object reachable from the signer");
  }
});

test("never exposes the private key", () => {
  const signer = createSessionSigner(keyFromSeed(RFC_TEST_SEED));
  const exposed = JSON.stringify(signer) + Object.values(signer).map(String).join("");
  assert.ok(!exposed.includes(Buffer.from(RFC_TEST_SEED, "hex").toString("base64")));
  assert.ok(!exposed.includes(RFC_TEST_SEED));
});

test("signs the bridge challenge bytes", () => {
  const signer = createSessionSigner();
  const draft = decodeDraft(wireFor(textPayload(), signer.publicKeyB64), signer, 1_800_000_000);
  const proof = createProof(draft, signer, 1_800_000_000);
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(signer.publicKeyB64, "base64").toString("base64url") }, format: "jwk" });
  assert.equal(proof.draft_id, draft.payload.draft_id);
  assert.ok(verify(null, draft.challengeBytes, publicKey, Buffer.from(proof.signature_b64, "base64")));
});

test("refuses to sign an expired draft", () => {
  const signer = createSessionSigner(keyFromSeed(RFC_TEST_SEED));
  const draft = decodeDraft(fixtureWire(), signer, fixture.now);
  assert.throws(() => createProof(draft, signer, fixture.expires_at), /expired/);
});

test("a destroyed signer can no longer sign", () => {
  const signer = createSessionSigner(keyFromSeed(RFC_TEST_SEED));
  const draft = decodeDraft(fixtureWire(), signer, fixture.now);
  destroySessionSigner(signer);
  assert.throws(() => createProof(draft, signer, fixture.now), /disposed/);
  assert.throws(() => signer.sign(draft.challengeBytes), /disposed/);
});
