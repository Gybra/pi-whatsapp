import { createHash, createPublicKey, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";
import type { ApprovalProof, ReviewedDraft, SessionSigner } from "./protocol.ts";

/**
 * Holds this Pi session's approval key. The private key lives only in this closure:
 * it is never persisted, exported or reachable from the returned object.
 */
export function createSessionSigner(privateKey: KeyObject = generateKeyPairSync("ed25519").privateKey): SessionSigner {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("approval key must be Ed25519");
  let key: KeyObject | undefined = privateKey;
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x as string, "base64url");
  return {
    publicKeyB64: raw.toString("base64"),
    approverID: createHash("sha256").update(raw).digest("hex"),
    sign(challenge: Uint8Array): string {
      if (!key) throw new Error("approval signer disposed");
      return ed25519Sign(null, challenge, key).toString("base64");
    },
    dispose(): void {
      key = undefined;
    },
  };
}

export function destroySessionSigner(signer: SessionSigner): void {
  signer.dispose();
}

/** Signs a reviewed draft. Only call after the user approved this exact draft. */
export function createProof(draft: ReviewedDraft, signer: SessionSigner, nowSeconds: number): ApprovalProof {
  if (nowSeconds >= draft.payload.expires_at) throw new Error("draft expired");
  if (draft.wire.approver_id !== signer.approverID) throw new Error("draft belongs to another approver");
  return { draft_id: draft.payload.draft_id, signature_b64: signer.sign(draft.challengeBytes) };
}
