import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { createApprovalController, createSessionSigner, destroySessionSigner, isOutgoingWhatsAppCall, type ApprovalController } from "../src/approval.ts";
import { createBridgeClient, type BridgeClient } from "../src/bridge-client.ts";
import { loadBridgeToken } from "../src/config.ts";
import type { SessionSigner } from "../src/protocol.ts";
import { reviewDraft } from "../src/review.ts";

export type Deps = {
  createSigner(): SessionSigner;
  connect(): BridgeClient | Promise<BridgeClient>;
};

const defaultDeps: Deps = {
  createSigner: () => createSessionSigner(),
  connect: async () => createBridgeClient(await loadBridgeToken()),
};

export default function (pi: ExtensionAPI): void {
  setup(pi, defaultDeps);
}

export function setup(pi: ExtensionAPI, deps: Deps): void {
  // One approval key per Pi process: it survives /new and /resume, and is
  // destroyed (and its bridge trust revoked) when Pi quits or reloads.
  let signer: SessionSigner | undefined;
  let client: BridgeClient | undefined;
  let controller: ApprovalController | undefined;

  async function getController(): Promise<ApprovalController | undefined> {
    if (!signer) return undefined;
    if (!controller) {
      try {
        client = await deps.connect();
      } catch {
        return undefined;
      }
      controller = createApprovalController(client, signer, reviewDraft);
    }
    return controller;
  }

  pi.on("session_start", () => {
    signer ??= deps.createSigner();
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    if (!isOutgoingWhatsAppCall(event)) return undefined;
    const ready = await getController();
    if (!ready) {
      delete (event.input as Record<string, unknown>).approval;
      return {
        block: true,
        reason: "The WhatsApp bridge is not set up for this Pi session (run whatsapp-mcp setup, then /whatsapp-pair). Nothing was sent.",
      };
    }
    return ready.handle(event, ctx);
  });

  pi.on("session_shutdown", async (event) => {
    await controller?.cancelAll();
    if (event.reason !== "quit" && event.reason !== "reload") return;
    const current = signer;
    signer = undefined;
    controller = undefined;
    if (!current) return;
    try {
      client ??= await deps.connect();
      const status = await client.status(AbortSignal.timeout(2000));
      if (status.approver_id === current.approverID) await client.revoke(AbortSignal.timeout(2000));
    } catch {
      // The bridge may be down; the lease still expires on its own.
    } finally {
      destroySessionSigner(current);
    }
  });
}
