import type { BRIDGE_STATES } from "../bridge-client.ts";
import type { SendInput } from "./approval.ts";

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

export type BridgeRelease = { version: string | null; assets: Record<string, { file: string; sha256: string }> };
