import { createHash } from "node:crypto";

// Wire format of the bridge's approval protocol v1 (whatsapp-mcp docs/approval-protocol-v1.md).
// Drafts are parsed from the exact bytes the bridge will send, never rebuilt locally.
export const APPROVAL_DOMAIN = "whatsapp-mcp/approval/v1";
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024; // message plus worst-case JSON escaping
const KINDS = ["text", "file", "voice"] as const;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type SendKind = (typeof KINDS)[number];

export type SendInput = { kind: SendKind; recipient: string; message: string; media_id: string };

export type AttachmentView = { id: string; name: string; mime: string; size: number; sha256: string };

export type ApprovalPayload = {
  version: 1;
  draft_id: string;
  recipient_jid: string;
  message: string;
  kind: SendKind;
  attachment: AttachmentView | null;
  expires_at: number;
};

export type DraftView = { draft_id: string; payload_b64: string; challenge_b64: string; approver_id: string; expires_at: number };

export type ApprovalProof = { draft_id: string; signature_b64: string };

export type SessionSigner = {
  readonly publicKeyB64: string;
  readonly approverID: string;
  sign(challenge: Uint8Array): string;
  dispose(): void;
};

export type ReviewedDraft = { wire: DraftView; payload: ApprovalPayload; payloadBytes: Uint8Array; challengeBytes: Uint8Array };

/** Validates a bridge draft for this session's signer. Throws on anything unexpected. */
export function decodeDraft(wire: unknown, signer: SessionSigner, nowSeconds: number): ReviewedDraft {
  if (!hasExactKeys(wire, ["approver_id", "challenge_b64", "draft_id", "expires_at", "payload_b64"])) fail("unexpected draft fields");
  const { draft_id, approver_id, expires_at } = wire;
  if (typeof draft_id !== "string" || !HEX32.test(draft_id) || approver_id !== signer.approverID || !Number.isSafeInteger(expires_at)) {
    fail("draft identity");
  }
  const payloadBytes = decodeBase64(wire.payload_b64);
  const challengeBytes = decodeBase64(wire.challenge_b64);
  if (payloadBytes.length > MAX_PAYLOAD_BYTES || !challengeMatches(challengeBytes, payloadBytes, signer.publicKeyB64)) {
    fail("challenge does not match payload and approver");
  }
  const payload = parsePayload(payloadBytes);
  if (payload.draft_id !== draft_id || payload.expires_at !== expires_at) fail("draft metadata mismatch");
  if (nowSeconds >= payload.expires_at) throw new Error("draft expired");
  return {
    wire: { draft_id, payload_b64: wire.payload_b64 as string, challenge_b64: wire.challenge_b64 as string, approver_id: signer.approverID, expires_at: payload.expires_at },
    payload,
    payloadBytes,
    challengeBytes,
  };
}

function challengeMatches(challenge: Buffer, payload: Buffer, publicKeyB64: string): boolean {
  const expected = Buffer.concat([Buffer.from(APPROVAL_DOMAIN + "\0"), Buffer.alloc(32), sha256(payload), sha256(Buffer.from(publicKeyB64, "base64"))]);
  const nonceStart = APPROVAL_DOMAIN.length + 1;
  if (challenge.length !== expected.length) return false;
  challenge.copy(expected, nonceStart, nonceStart, nonceStart + 32); // the nonce is opaque
  return challenge.equals(expected);
}

function parsePayload(bytes: Buffer): ApprovalPayload {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("payload is not UTF-8 JSON");
  }
  if (!hasExactKeys(value, ["attachment", "draft_id", "expires_at", "kind", "message", "recipient_jid", "version"])) fail("unexpected payload fields");
  const p = value as Record<string, unknown>;
  const valid =
    p.version === 1 &&
    typeof p.draft_id === "string" && HEX32.test(p.draft_id) &&
    typeof p.recipient_jid === "string" && p.recipient_jid !== "" &&
    typeof p.message === "string" && Buffer.byteLength(p.message) <= MAX_MESSAGE_BYTES &&
    Number.isSafeInteger(p.expires_at) &&
    KINDS.includes(p.kind as SendKind);
  if (!valid) fail("payload values");
  if (p.kind === "text" ? p.attachment !== null || p.message === "" : !isAttachment(p.attachment)) fail("payload kind and attachment");
  return p as ApprovalPayload;
}

function isAttachment(value: unknown): value is AttachmentView {
  if (!hasExactKeys(value, ["id", "mime", "name", "sha256", "size"])) return false;
  const { id, name, mime, size, sha256 } = value;
  return [id, name, mime].every((s) => typeof s === "string" && s !== "") &&
    Number.isSafeInteger(size) && (size as number) >= 0 && (size as number) <= MAX_MEDIA_BYTES &&
    typeof sha256 === "string" && HEX64.test(sha256);
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, i) => key === keys[i] && (value as Record<string, unknown>)[key] !== undefined);
}

/** Accepts only standard padded base64 that re-encodes identically. */
function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail("base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("base64");
  return bytes;
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function fail(reason: string): never {
  throw new Error(`invalid draft: ${reason}`);
}
