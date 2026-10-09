import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { createApprovalController, createSessionSigner, destroySessionSigner, isOutgoingWhatsAppCall, type ApprovalController } from "../src/approval.ts";
import { bridgeStatus, pairPi, runBridgeCommand, startLink } from "../src/bridge-cli.ts";
import { createBridgeClient, type BridgeClient } from "../src/bridge-client.ts";
import { bridgeDataDir, checkBridgeExecutable, configPath, findConfiguredServer, isSameBridge, loadBridgeToken, loadConfig, saveConfig } from "../src/config.ts";
import { protectedToolCall } from "../src/guard.ts";
import { assetFor, installBridge, type BridgeRelease } from "../src/install.ts";
import { runLinkScreen } from "../src/link-view.ts";
import type { SessionSigner } from "../src/protocol.ts";
import { reviewDraft } from "../src/review.ts";

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

const defaultDeps = (): Deps => ({
  agentDir: getAgentDir(),
  dataDir: () => {
    try {
      return bridgeDataDir();
    } catch {
      return "";
    }
  },
  release: JSON.parse(readFileSync(new URL("../bridge-release.json", import.meta.url), "utf8")) as BridgeRelease,
  platform: process.platform,
  arch: process.arch,
  createSigner: () => createSessionSigner(),
  connect: async () => createBridgeClient(await loadBridgeToken()),
});

export default function (pi: ExtensionAPI): void {
  setup(pi, defaultDeps());
}

const interactive = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;
const NOT_SET_UP = "WhatsApp is not set up in Pi yet: the user can run /whatsapp-setup. Nothing was sent.";

export function setup(pi: ExtensionAPI, deps: Deps): void {
  // One approval key per Pi process: it survives /new and /resume, and is
  // destroyed (and its bridge trust revoked) when Pi quits or reloads.
  let signer: SessionSigner | undefined;
  let client: BridgeClient | undefined;
  let controller: ApprovalController | undefined;
  let registeredBridge: string | undefined;
  const installDir = join(deps.agentDir, "pi-whatsapp-bridge");
  const guardPaths = { dataDir: deps.dataDir(), installDir, configFile: configPath(deps.agentDir) };

  const bridgePath = async () => (await loadConfig(configPath(deps.agentDir)).catch(() => null))?.bridgePath;

  async function getClient(): Promise<BridgeClient> {
    client ??= await deps.connect();
    return client;
  }

  /** Asks once per Pi process before trusting this session to approve messages. */
  async function ensurePaired(ctx: ExtensionContext): Promise<boolean> {
    const path = await bridgePath();
    if (!signer || !path || !interactive(ctx)) return false;
    const ok = await ctx.ui.confirm(
      "Allow this Pi session to approve WhatsApp messages?",
      "Pi asks this once per session. You will still see and approve every message before it is sent.",
    );
    return ok && (await pairPi(path, signer.publicKeyB64)) === signer.approverID;
  }

  async function getController(): Promise<ApprovalController | undefined> {
    if (!signer || !(await bridgePath())) return undefined;
    try {
      controller ??= createApprovalController(await getClient(), signer, reviewDraft, undefined, ensurePaired);
    } catch {
      return undefined;
    }
    return controller;
  }

  /** Registers the bridge for this Pi runtime only, unless Pi's own MCP files already define "whatsapp". */
  async function registerBridge(ctx: ExtensionContext, path: string): Promise<void> {
    if (registeredBridge === path) return;
    const existing = await findConfiguredServer(deps.agentDir, ctx.cwd);
    if (existing) {
      if (!isSameBridge(existing, path)) {
        ctx.ui.notify(`${existing.source} already defines a "whatsapp" server, which Pi uses instead of ${path}. It was left unchanged.`, "warning");
      }
      return;
    }
    pi.registerMcpServer("whatsapp", { command: path, args: ["mcp"], timeout: 180, exposure: "codemode" });
    registeredBridge = path;
  }

  pi.on("session_start", async (_event, ctx) => {
    signer ??= deps.createSigner();
    try {
      const config = await loadConfig(configPath(deps.agentDir));
      if (config) await registerBridge(ctx, config.bridgePath);
    } catch (error) {
      ctx.ui.notify((error as Error).message, "warning");
    }
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    const blocked = protectedToolCall(event as { toolName: string; input: Record<string, unknown> }, guardPaths);
    if (blocked) return { block: true, reason: blocked };
    if (!isOutgoingWhatsAppCall(event)) return undefined;
    const ready = await getController();
    if (!ready) {
      delete (event.input as Record<string, unknown>).approval;
      return { block: true, reason: NOT_SET_UP };
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
      // The bridge may be down; its stale public key is useless without this process's private key.
    } finally {
      destroySessionSigner(current);
    }
  });

  /** Finds the bridge executable: the one given, the configured one, or a verified download. */
  async function chooseBridge(ctx: ExtensionContext, given: string): Promise<string | undefined> {
    if (given) {
      const problem = await checkBridgeExecutable(given);
      if (problem) return void ctx.ui.notify(`Not a usable bridge: ${problem}.`, "error");
      const ok = await ctx.ui.confirm("Use this WhatsApp bridge?", `${given}\n\nPi will run "${given} mcp" for its sessions. Pi's settings and mcp.json are not changed.`);
      return ok ? given : undefined;
    }
    const configured = await bridgePath();
    if (configured && !(await checkBridgeExecutable(configured))) return configured;
    const asset = assetFor(deps.release, deps.platform, deps.arch);
    const download = `Download and install whatsapp-mcp v${deps.release.version} (checksum verified)`;
    const existing = "Use an existing whatsapp-mcp executable";
    const choice = await ctx.ui.select("Which WhatsApp bridge should Pi use?", asset ? [download, existing] : [existing]);
    if (choice === download) {
      ctx.ui.notify(`Downloading whatsapp-mcp v${deps.release.version}…`, "info");
      return installBridge({ installDir, release: deps.release, platform: deps.platform, arch: deps.arch, fetchImpl: deps.fetchImpl });
    }
    if (choice !== existing) return undefined;
    const path = (await ctx.ui.input("Absolute path to the whatsapp-mcp executable", "/usr/local/bin/whatsapp-mcp"))?.trim();
    if (!path) return undefined;
    const problem = await checkBridgeExecutable(path);
    if (problem) return void ctx.ui.notify(`Not a usable bridge: ${problem}.`, "error");
    return path;
  }

  pi.registerCommand("whatsapp-setup", {
    description: "Set up WhatsApp for Pi: install the bridge, link your phone and start it",
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return ctx.ui.notify("WhatsApp setup needs Pi's interactive terminal.", "error");
      try {
        const path = await chooseBridge(ctx, args.trim());
        if (!path) return;
        await saveConfig(configPath(deps.agentDir), { bridgePath: path });
        await registerBridge(ctx, path);
        let status = await bridgeStatus(path);
        if (!status.linked) {
          const link = await ctx.ui.confirm(
            "Link this computer to your WhatsApp account now?",
            "WhatsApp will list it under Linked devices on your phone. You can remove it there at any time.",
          );
          if (!link) return ctx.ui.notify("WhatsApp is not linked yet. Run /whatsapp-setup again when you are ready.", "info");
          if (status.running) await runBridgeCommand(path, ["stop"]); // the unlinked bridge holds the session database
          if (!(await runLinkScreen(ctx, (onEvent) => startLink(path, onEvent)))) return ctx.ui.notify("WhatsApp was not linked.", "warning");
          status = await bridgeStatus(path);
        }
        if (!status.running && !status.autostart) {
          const always = "Start automatically when I log in (recommended)";
          const now = "Start it now, until I log out";
          const choice = await ctx.ui.select("The bridge keeps WhatsApp connected in the background. When should it run?", [always, now, "Don't start it now"]);
          if (choice === always) await runBridgeCommand(path, ["autostart", "enable"]);
          else if (choice === now) await runBridgeCommand(path, ["start"]);
        } else if (!status.running) {
          await runBridgeCommand(path, ["start"]);
        }
        ctx.ui.notify("WhatsApp is ready. Before the first message, Pi asks once to approve messages from this session; every message is shown to you before it is sent.", "info");
      } catch (error) {
        ctx.ui.notify(`WhatsApp setup failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("whatsapp-pair", {
    description: "Let this Pi session approve outgoing WhatsApp messages",
    handler: async (_args, ctx) => {
      if (!interactive(ctx)) return ctx.ui.notify("Pairing needs Pi's interactive terminal.", "error");
      if (!(await bridgePath())) return ctx.ui.notify("Run /whatsapp-setup first.", "error");
      try {
        const paired = await ensurePaired(ctx);
        ctx.ui.notify(paired ? "This Pi session can now approve WhatsApp messages." : "Not paired.", paired ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`Pairing failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("whatsapp-status", {
    description: "Show the WhatsApp bridge and pairing status",
    handler: async (_args, ctx) => {
      const path = await bridgePath();
      if (!path) return ctx.ui.notify("WhatsApp is not set up: run /whatsapp-setup.", "info");
      try {
        const s = await bridgeStatus(path);
        const pairing = signer && s.approver_id === signer.approverID ? "this session can approve messages" : s.approver_id ? "paired with another Pi session" : "not paired (Pi asks before the first message)";
        ctx.ui.notify(`WhatsApp bridge: ${s.running ? s.state : "not running"} · ${s.linked ? "linked" : "not linked"} · autostart ${s.autostart ? "on" : "off"} · ${pairing}`, "info");
      } catch (error) {
        ctx.ui.notify(`WhatsApp bridge status unavailable: ${(error as Error).message}`, "error");
      }
    },
  });
}
