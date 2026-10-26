import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { BRIDGE_STATES } from "./bridge-client.ts";
import type { KINDS } from "./protocol.ts";

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

export type BridgeState = (typeof BRIDGE_STATES)[number];

export type RuntimeStatus = {
  state: BridgeState;
  connected: boolean;
  approver_id: string;
};

export type BridgeClient = {
  status(signal?: AbortSignal): Promise<RuntimeStatus>;
  /** Returns the bridge's draft as received; callers validate it with decodeDraft. */
  prepare(input: SendInput, signal: AbortSignal): Promise<unknown>;
  cancel(draftID: string, signal?: AbortSignal): Promise<void>;
  revoke(signal?: AbortSignal): Promise<void>;
  preview(draftID: string, signal: AbortSignal): Promise<Uint8Array>;
};

export type BridgeStatus = {
  version: string;
  running: boolean;
  state: BridgeState;
  connected: boolean;
  linked: boolean;
  approver_id: string;
  autostart: boolean;
  data_dir: string;
  log_file: string;
};

export type LinkEvent = { event: "qr"; modules: string[]; expires_in: number } | { event: "notice" | "linked"; message: string } | { event: "confirm_code"; code: string; message: string };

/** How a bridge command ended; `error` is the bridge's own message. */
export type BridgeOutcome = { ok: true } | { ok: false; error: string };

export type LinkProcess = {
  /** Answers a confirm_code event. */
  answer(confirmed: boolean): void;
  cancel(): void;
  done: Promise<BridgeOutcome>;
};

export type ConfiguredServer = { source: string; command?: unknown; args?: unknown };

export type BridgeRelease = { version: string | null; assets: Record<string, { file: string; sha256: string }> };

export type ApprovalController = {
  handle(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined>;
  cancelAll(): Promise<void>;
};

export type Deps = {
  agentDir: string;
  dataDir(): string;
  release: BridgeRelease;
  platform: NodeJS.Platform;
  arch: string;
  fetchImpl?: typeof fetch;
  createSigner(): SessionSigner;
  connect(): BridgeClient | Promise<BridgeClient>;
};

