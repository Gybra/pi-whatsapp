import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { KINDS } from "../protocol.ts";

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

export type ApprovalController = {
  handle(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined>;
  cancelAll(): Promise<void>;
};
