import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createProof, createSessionSigner } from "../src/approval.ts";
import { decodeDraft } from "../src/protocol.ts";
import { fixture, fixtureWire, keyFromSeed, RFC_TEST_SEED, textPayload, wireFor } from "./helpers.ts";

const NOW = 1_800_000_000;
const rfcSigner = () => createSessionSigner(keyFromSeed(RFC_TEST_SEED));

test("accepts the Go protocol vector and reproduces its signature", () => {
  const signer = rfcSigner();
  assert.equal(signer.publicKeyB64, fixture.public_key_b64);
  assert.equal(signer.approverID, fixture.approver_id);

  const draft = decodeDraft(fixtureWire(), signer, fixture.now);
  assert.equal(draft.payload.recipient_jid, "12025550123@s.whatsapp.net");
  assert.equal(draft.payload.message, "Ciao Davide — test & <ok> ✓");
  assert.equal(draft.payload.kind, "file");
  const media = Buffer.from(fixture.media_b64, "base64");
  assert.equal(draft.payload.attachment?.sha256, createHash("sha256").update(media).digest("hex"));
  assert.deepEqual(Buffer.from(draft.payloadBytes), Buffer.from(fixture.payload_b64, "base64"));

  const proof = createProof(draft, signer, fixture.now);
  assert.deepEqual(proof, { draft_id: fixture.draft_id, signature_b64: fixture.signature_b64 });
});

test("rejects a payload that differs from the signed challenge by one byte", () => {
  const original = Buffer.from(fixture.payload_b64, "base64");
  for (const index of [0, 40, original.length - 2]) {
    const tampered = Buffer.from(original);
    tampered[index] ^= 0x01;
    const wire = { ...fixtureWire(), payload_b64: tampered.toString("base64") };
    assert.throws(() => decodeDraft(wire, rfcSigner(), fixture.now), /invalid draft/);
  }
});

test("rejects a challenge with a modified domain, payload hash or key hash", () => {
  const original = Buffer.from(fixture.challenge_b64, "base64");
  for (const index of [0, 25 + 32, original.length - 1]) {
    const tampered = Buffer.from(original);
    tampered[index] ^= 0x01;
    const wire = { ...fixtureWire(), challenge_b64: tampered.toString("base64") };
    assert.throws(() => decodeDraft(wire, rfcSigner(), fixture.now), /invalid draft/);
  }
});

test("rejects a draft bound to another approver key", () => {
  assert.throws(() => decodeDraft(fixtureWire(), createSessionSigner(), fixture.now), /invalid draft/);
});

test("rejects expired drafts at expires_at", () => {
  assert.throws(() => decodeDraft(fixtureWire(), rfcSigner(), fixture.expires_at), /expired/);
  assert.doesNotThrow(() => decodeDraft(fixtureWire(), rfcSigner(), fixture.expires_at - 1));
});

test("rejects malformed draft wire objects", () => {
  const good = fixtureWire();
  const cases: Record<string, unknown> = {
    "not an object": "draft",
    "missing field": { ...good, approver_id: undefined },
    "extra field": { ...good, approved: true },
    "numeric draft id": { ...good, draft_id: 7 },
    "unpadded base64": { ...good, payload_b64: good.payload_b64.replace(/=+$/, "") },
    "base64 with newline": { ...good, payload_b64: good.payload_b64.slice(0, 8) + "\n" + good.payload_b64.slice(8) },
    "approver id mismatch": { ...good, approver_id: "0".repeat(64) },
    "draft id mismatch": { ...good, draft_id: "f".repeat(32) },
    "expiry mismatch": { ...good, expires_at: good.expires_at + 60 },
  };
  for (const [name, wire] of Object.entries(cases)) {
    assert.throws(() => decodeDraft(wire, rfcSigner(), fixture.now), /invalid draft/, name);
  }
});

test("validates the reviewed payload", () => {
  const signer = rfcSigner();
  assert.equal(decodeDraft(wireFor(textPayload(), signer.publicKeyB64), signer, NOW).payload.message, "hello");

  const attachment = { id: "a.pdf", name: "a.pdf", mime: "application/pdf", size: 3, sha256: "a".repeat(64) };
  const cases: Record<string, Uint8Array | object> = {
    "version 2": textPayload({ version: 2 }),
    "unknown field": textPayload({ approved: true }),
    "missing field": { ...textPayload(), attachment: undefined },
    "unknown kind": textPayload({ kind: "poll" }),
    "text with attachment": textPayload({ attachment }),
    "file without attachment": textPayload({ kind: "file" }),
    "empty text": textPayload({ message: "" }),
    "empty recipient": textPayload({ recipient_jid: "" }),
    "short draft id": textPayload({ draft_id: "abc" }),
    "message over 32 KiB": textPayload({ message: "é".repeat(16 * 1024 + 1) }),
    "attachment over 16 MiB": textPayload({ kind: "file", attachment: { ...attachment, size: 16 * 1024 * 1024 + 1 } }),
    "attachment hash not hex": textPayload({ kind: "file", attachment: { ...attachment, sha256: "z".repeat(64) } }),
    "attachment extra field": textPayload({ kind: "file", attachment: { ...attachment, path: "/etc/passwd" } }),
    "invalid utf-8": Buffer.from([0x7b, 0xff, 0x7d]),
  };
  for (const [name, payload] of Object.entries(cases)) {
    assert.throws(() => decodeDraft(wireFor(payload, signer.publicKeyB64), signer, NOW), /invalid draft/, name);
  }
});
