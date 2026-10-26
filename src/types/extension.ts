import type { SessionSigner } from "./approval.ts";
import type { BridgeClient, BridgeRelease } from "./bridge.ts";

export type ConfiguredServer = { source: string; command?: unknown; args?: unknown };

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
