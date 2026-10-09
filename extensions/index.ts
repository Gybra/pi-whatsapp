import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { createApprovalController, createSessionSigner, destroySessionSigner, isOutgoingWhatsAppCall, type ApprovalController } from "../src/approval.ts";
import { createBridgeClient, type BridgeClient } from "../src/bridge-client.ts";
import { checkBridgeExecutable, configPath, findConfiguredServer, isSameBridge, loadBridgeToken, loadConfig, saveConfig } from "../src/config.ts";
import { runPairing } from "../src/pairing.ts";
import type { SessionSigner } from "../src/protocol.ts";
import { reviewDraft } from "../src/review.ts";

export type Deps = {
  agentDir: string;
  createSigner(): SessionSigner;
  connect(): BridgeClient | Promise<BridgeClient>;
};

const defaultDeps: Deps = {
  agentDir: getAgentDir(),
  createSigner: () => createSessionSigner(),
  connect: async () => createBridgeClient(await loadBridgeToken()),
};

export default function (pi: ExtensionAPI): void {
  setup(pi, defaultDeps);
}

const interactive = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;

export function setup(pi: ExtensionAPI, deps: Deps): void {
  // One approval key per Pi process: it survives /new and /resume, and is
  // destroyed (and its bridge trust revoked) when Pi quits or reloads.
  let signer: SessionSigner | undefined;
  let client: BridgeClient | undefined;
  let controller: ApprovalController | undefined;
  let registeredBridge: string | undefined;

  async function getClient(): Promise<BridgeClient> {
    client ??= await deps.connect();
    return client;
  }

  async function getController(): Promise<ApprovalController | undefined> {
    if (!signer) return undefined;
    try {
      controller ??= createApprovalController(await getClient(), signer, reviewDraft);
    } catch {
      return undefined;
    }
    return controller;
  }

  /** Registers the bridge for this Pi runtime only, unless Pi's own MCP files already define "whatsapp". */
  async function registerBridge(ctx: ExtensionContext, bridgePath: string): Promise<void> {
    if (registeredBridge === bridgePath) return;
    const existing = await findConfiguredServer(deps.agentDir, ctx.cwd);
    if (existing) {
      if (!isSameBridge(existing, bridgePath)) {
        ctx.ui.notify(`${existing.source} already defines a "whatsapp" server, which Pi uses instead of ${bridgePath}. It was left unchanged.`, "warning");
      }
      return;
    }
    pi.registerMcpServer("whatsapp", { command: bridgePath, args: ["mcp"], timeout: 180, exposure: "codemode" });
    registeredBridge = bridgePath;
  }

  /** Reminds the user to pair, without holding up Pi's startup for more than a moment. */
  async function remindToPair(ctx: ExtensionContext, current: SessionSigner): Promise<void> {
    const check = (async () => {
      const status = await (await getClient()).status(AbortSignal.timeout(1500));
      return status.approver_id === current.approverID;
    })();
    const paired = await Promise.race([check, new Promise<undefined>((resolve) => setTimeout(resolve, 1500))]).catch(() => undefined);
    if (paired === false) ctx.ui.notify("WhatsApp: run /whatsapp-pair to approve outgoing messages from this Pi session.", "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    signer ??= deps.createSigner();
    try {
      const config = await loadConfig(configPath(deps.agentDir));
      if (!config) return;
      await registerBridge(ctx, config.bridgePath);
      if (ctx.hasUI) await remindToPair(ctx, signer);
    } catch (error) {
      ctx.ui.notify((error as Error).message, "warning");
    }
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
      const bridge = await getClient();
      const status = await bridge.status(AbortSignal.timeout(2000));
      if (status.approver_id === current.approverID) await bridge.revoke(AbortSignal.timeout(2000));
    } catch {
      // The bridge may be down; the lease still expires on its own.
    } finally {
      destroySessionSigner(current);
    }
  });

  pi.registerCommand("whatsapp-setup", {
    description: "Connect Pi to an installed whatsapp-mcp bridge",
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return ctx.ui.notify("WhatsApp setup needs Pi's interactive terminal.", "error");
      const path = args.trim() || (await ctx.ui.input("Absolute path to the whatsapp-mcp executable", "/usr/local/bin/whatsapp-mcp"))?.trim();
      if (!path) return;
      const problem = await checkBridgeExecutable(path);
      if (problem) return ctx.ui.notify(`Not a usable bridge: ${problem}.`, "error");
      const confirmed = await ctx.ui.confirm(
        "Use this WhatsApp bridge?",
        `${path}\n\nPi will run "${path} mcp" for its sessions. Pi's settings and mcp.json are not changed.`,
      );
      if (!confirmed) return;
      await saveConfig(configPath(deps.agentDir), { bridgePath: path });
      await registerBridge(ctx, path);
      ctx.ui.notify("WhatsApp bridge configured. Run /whatsapp-pair to let this session approve messages.", "info");
    },
  });

  pi.registerCommand("whatsapp-pair", {
    description: "Let this Pi session approve outgoing WhatsApp messages",
    handler: async (_args, ctx) => {
      if (!interactive(ctx)) return ctx.ui.notify("Pairing needs Pi's interactive terminal.", "error");
      if (!signer) return ctx.ui.notify("No Pi session is active.", "error");
      let bridge: BridgeClient;
      try {
        bridge = await getClient();
      } catch {
        return ctx.ui.notify("The WhatsApp bridge is not set up: run whatsapp-mcp setup in a terminal first.", "error");
      }
      const config = await loadConfig(configPath(deps.agentDir)).catch(() => null);
      const paired = await runPairing(ctx, bridge, signer, config?.bridgePath);
      ctx.ui.notify(paired ? "Paired: this Pi session can now approve WhatsApp messages." : "Pairing not completed.", paired ? "info" : "warning");
    },
  });

  pi.registerCommand("whatsapp-status", {
    description: "Show the WhatsApp bridge and pairing status",
    handler: async (_args, ctx) => {
      try {
        const status = await (await getClient()).status(AbortSignal.timeout(5000));
        const pairing =
          signer && status.approver_id === signer.approverID
            ? "paired with this session"
            : status.approver_id
              ? "paired with another Pi session"
              : "not paired (run /whatsapp-pair)";
        ctx.ui.notify(`WhatsApp bridge: ${status.state}${status.connected ? "" : " (not connected)"} · ${pairing}`, "info");
      } catch {
        ctx.ui.notify("The WhatsApp bridge is not reachable or not set up.", "error");
      }
    },
  });
}
