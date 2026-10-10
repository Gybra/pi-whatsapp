import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runBridgeCommand, runBridgeInTerminal, type BridgeOutcome } from "./bridge-cli.ts";
import { checkBridgeExecutable, configPath, findConfiguredServer, loadConfig, type ConfiguredServer } from "./config.ts";

// Undoes /whatsapp-setup. The bridge's own `uninstall` stops it and removes its login
// service; this removes only what the extension created, never mcp.json or a bridge the
// user supplied. Each step is safe to repeat, so a failed run can simply be run again.

export type UninstallPaths = { agentDir: string; installDir: string; dataDir: string };

/** What /whatsapp-setup left on this computer. */
type Installation = {
  configFile: string;
  /** Pi's WhatsApp settings file exists, valid or not. */
  hasConfig: boolean;
  /** The configured bridge, when it can be run. */
  bridge?: string;
  /** Set up, but the bridge cannot be run from Pi: its executable is missing or the settings are invalid. */
  bridgeUnreachable: boolean;
  /** Why the configured bridge cannot be run, when known. */
  problem?: string;
  /** Pi downloaded a bridge into the install directory. */
  downloaded: boolean;
};

const KEEP = "Keep local data (recommended): the WhatsApp session, message history and downloads stay on this computer";
const PURGE = "Purge local data: delete the WhatsApp session, message history, downloads and credentials";
const DELETE = "Delete my local WhatsApp data permanently";
const UNLINK = "Also remove this computer in WhatsApp on your phone, under Settings › Linked devices: deleting local data does not unlink it.";
const PACKAGE = 'To remove the extension too, run "pi uninstall npm:pi-whatsapp" in a terminal (or the source "pi list" shows).';

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function inspect(paths: UninstallPaths): Promise<Installation> {
  const configFile = configPath(paths.agentDir);
  let hasConfig = true;
  let bridgePath: string | undefined;
  try {
    const config = await loadConfig(configFile);
    hasConfig = config !== null;
    bridgePath = config?.bridgePath;
  } catch {
    // An invalid settings file is still ours to remove; only its bridge is unknown.
  }
  const problem = bridgePath ? await checkBridgeExecutable(bridgePath) : undefined;
  const bridge = bridgePath && !problem ? bridgePath : undefined;
  return { configFile, hasConfig, bridge, bridgeUnreachable: hasConfig && !bridge, problem, downloaded: existsSync(paths.installDir) };
}

function describePlan(installation: Installation, installDir: string): string {
  const { bridge, problem } = installation;
  const steps: string[] = [];
  if (bridge) steps.push(`• Stop the WhatsApp bridge (${bridge}) and remove its start-at-login service.`);
  if (installation.bridgeUnreachable) steps.push(`• The bridge cannot be stopped from Pi${problem ? `: ${problem}` : ""}.`);
  if (installation.hasConfig) steps.push(`• Delete Pi's WhatsApp settings (${installation.configFile}).`);
  if (installation.downloaded) steps.push(`• Delete the bridge Pi downloaded (${installDir}).`);
  if (bridge && !isInside(installDir, bridge)) steps.push(`• Keep your own bridge executable (${bridge}).`);
  steps.push("• Leave your mcp.json files unchanged.");
  return steps.join("\n");
}

/** Asks Keep or Purge; undefined means the user cancelled. */
async function choosePurge(ctx: ExtensionContext, dataDir: string): Promise<boolean | undefined> {
  const choice = await ctx.ui.select("What should happen to your WhatsApp data on this computer?", [KEEP, PURGE]);
  if (choice !== PURGE) return choice === KEEP ? false : undefined;
  // A select, so that Cancel is chosen by default for an irreversible deletion.
  const sure = await ctx.ui.select(
    `Permanently delete ${dataDir || "the bridge's data directory"}? It holds the linked WhatsApp session, the message history, downloaded files and the bridge's credentials. This cannot be undone; the bridge then asks you to type "yes" in the terminal.`,
    ["Cancel", DELETE],
  );
  return sure === DELETE ? true : undefined;
}

/** Hands Pi's terminal to the bridge, which confirms the purge there itself. */
function purgeInTerminal(ctx: ExtensionContext, bridge: string): Promise<BridgeOutcome> {
  return ctx.ui.custom<BridgeOutcome>((tui, _theme, _keys, done) => {
    tui.stop();
    if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
    const outcome = runBridgeInTerminal(bridge, ["uninstall", "--purge"]);
    tui.start();
    tui.requestRender(true);
    done(outcome);
    return { render: () => [], invalidate: () => {} };
  });
}

/** Stops the bridge and removes its autostart with the bridge's own uninstall. */
async function uninstallBridge(ctx: ExtensionContext, bridge: string, purge: boolean): Promise<BridgeOutcome> {
  if (purge) return purgeInTerminal(ctx, bridge);
  try {
    await runBridgeCommand(bridge, ["uninstall"], { timeoutMs: 60_000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function describeResult(installation: Installation, data: { dir: string; left: boolean; purged: boolean }, server: ConfiguredServer | undefined): string {
  const lines = ["WhatsApp was removed from Pi; its tools are no longer available in this session."];
  if (installation.bridgeUnreachable) {
    const problem = installation.problem ? ` (${installation.problem})` : "";
    lines.push(`The bridge could not be stopped from Pi${problem}. If it is still installed, run "whatsapp-mcp uninstall" in a terminal to stop it and remove its autostart.`);
  }
  if (data.left) lines.push(`Your WhatsApp session, message history and downloads remain in ${data.dir}. Delete that folder to remove them.`);
  else if (data.purged) lines.push("Your local WhatsApp data was deleted.");
  if (server) lines.push(`${server.source} still defines a "whatsapp" server, which Pi keeps using. It was left unchanged; remove it yourself if you no longer need it.`);
  return [...lines, UNLINK, PACKAGE].join("\n");
}

/**
 * Stops the bridge, removes its autostart and Pi's own WhatsApp files, after confirmation.
 * `forget` makes the running Pi process drop the bridge.
 */
export async function uninstallWhatsApp(ctx: ExtensionContext, paths: UninstallPaths, forget: () => Promise<void>): Promise<void> {
  const installation = await inspect(paths);
  if (!installation.hasConfig && !installation.downloaded) {
    await forget(); // a settings file deleted by hand can leave the bridge registered in this session
    return ctx.ui.notify(`WhatsApp is not set up in Pi, so there is nothing to remove.\n${PACKAGE}`, "info");
  }

  const cancelled = () => ctx.ui.notify("WhatsApp uninstall cancelled. Nothing was changed.", "info");
  if (!(await ctx.ui.confirm("Uninstall WhatsApp from Pi?", describePlan(installation, paths.installDir)))) return cancelled();
  const purge = installation.bridge ? await choosePurge(ctx, paths.dataDir) : false;
  if (purge === undefined) return cancelled();

  if (installation.bridge) {
    const outcome = await uninstallBridge(ctx, installation.bridge, purge);
    if (!outcome.ok) {
      return ctx.ui.notify(`The WhatsApp bridge could not be uninstalled: ${outcome.error}\nNothing else was changed. Run /whatsapp-uninstall again, or run "${installation.bridge}" uninstall in a terminal.`, "error");
    }
  }

  await forget(); // before deleting the download, which Pi's MCP connection may still be running
  try {
    await rm(installation.configFile, { force: true });
    await rm(paths.installDir, { recursive: true, force: true });
  } catch (error) {
    return ctx.ui.notify(`WhatsApp is disconnected from Pi, but some of its files could not be removed: ${(error as Error).message}\nRun /whatsapp-uninstall again to finish.`, "error");
  }

  const data = { dir: paths.dataDir, left: paths.dataDir !== "" && existsSync(paths.dataDir), purged: purge };
  const server = await findConfiguredServer(paths.agentDir, ctx.cwd);
  ctx.ui.notify(describeResult(installation, data, server), installation.bridgeUnreachable ? "warning" : "info");
}
