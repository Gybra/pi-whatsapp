import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

// RFC 8032 section 7.1 test 1 secret key: public, never a real approver key.
export const RFC_TEST_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function keyFromSeed(seedHex: string): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
}

type Fixture = {
  now: number;
  public_key_b64: string;
  approver_id: string;
  media_b64: string;
  draft_id: string;
  payload_b64: string;
  challenge_b64: string;
  expires_at: number;
  signature_b64: string;
};

export const fixture: Fixture = JSON.parse(readFileSync(new URL("./fixtures/approval-v1.json", import.meta.url), "utf8"));

export function fixtureWire() {
  const { draft_id, payload_b64, challenge_b64, approver_id, expires_at } = fixture;
  return { draft_id, payload_b64, challenge_b64, approver_id, expires_at };
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

/** Builds a draft wire object whose challenge is consistent with the given payload bytes and key. */
export function wireFor(payload: Uint8Array | object, publicKeyB64: string, overrides: Record<string, unknown> = {}) {
  const bytes = payload instanceof Uint8Array ? payload : Buffer.from(JSON.stringify(payload));
  const publicKey = Buffer.from(publicKeyB64, "base64");
  const challenge = Buffer.concat([Buffer.from("whatsapp-mcp/approval/v1\0"), Buffer.alloc(32, 7), sha256(bytes), sha256(publicKey)]);
  const parsed = payload instanceof Uint8Array ? {} : (payload as { draft_id?: string; expires_at?: number });
  return {
    draft_id: parsed.draft_id ?? "0".repeat(32),
    payload_b64: Buffer.from(bytes).toString("base64"),
    challenge_b64: challenge.toString("base64"),
    approver_id: sha256(publicKey).toString("hex"),
    expires_at: parsed.expires_at ?? 2_000_000_000,
    ...overrides,
  };
}

export function textPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    draft_id: "0".repeat(32),
    recipient_jid: "12025550123@s.whatsapp.net",
    message: "hello",
    kind: "text",
    attachment: null,
    expires_at: 2_000_000_000,
    ...overrides,
  };
}
