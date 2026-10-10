import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runBridgeCommand, runBridgeInTerminal } from "./bridge-cli.ts";
import { checkBridgeExecutable, configPath, findConfiguredServer, loadConfig } from "./config.ts";

// Undoes /whatsapp-setup. The bridge's own `uninstall` stops it and removes its login
// service; this removes only what the extension created, never mcp.json or a bridge the
// user supplied. Each step is safe to repeat, so a failed run can simply be run again.

export type UninstallPaths = { agentDir: string; installDir: string; dataDir: string };

type Outcome = { ok: true } | { ok: false; error: string };

const KEEP = "Keep local data (recommended): the WhatsApp session, message history and downloads stay on this computer";
const PURGE = "Purge local data: delete the WhatsApp session, message history, downloads and credentials";
const DELETE = "Delete my local WhatsApp data permanently";
const UNLINK = "Also remove this computer in WhatsApp on your phone, under Settings › Linked devices: deleting local data does not unlink it.";
const PACKAGE = 'To remove the extension too, run "pi uninstall npm:pi-whatsapp" in a terminal (or the source "pi list" shows).';

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Hands Pi's terminal to the bridge, which confirms the purge there itself. */
function purgeInTerminal(ctx: ExtensionContext, bridgePath: string): Promise<Outcome> {
  return ctx.ui.custom<Outcome>((tui, _theme, _keys, done) => {
    tui.stop();
    if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
    const outcome = runBridgeInTerminal(bridgePath, ["uninstall", "--purge"]);
    tui.start();
    tui.requestRender(true);
    done(outcome);
    return { render: () => [], invalidate: () => {} };
  });
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

/**
 * Stops the bridge, removes its autostart and Pi's own WhatsApp files, after confirmation.
 * `forget` makes the running Pi process drop the bridge.
 */
export async function uninstallWhatsApp(ctx: ExtensionContext, paths: UninstallPaths, forget: () => Promise<void>): Promise<void> {
  const configFile = configPath(paths.agentDir);
  const config = await loadConfig(configFile).catch(() => undefined); // an unreadable config is still ours to remove
  const downloaded = existsSync(paths.installDir);
  if (config === null && !downloaded) {
    await forget();
    return ctx.ui.notify(`WhatsApp is not set up in Pi, so there is nothing to remove.\n${PACKAGE}`, "info");
  }
  const bridgePath = config?.bridgePath;
  const problem = bridgePath ? await checkBridgeExecutable(bridgePath) : undefined;
  const bridge = bridgePath && !problem ? bridgePath : undefined;

  const plan = [
    bridge ? `• Stop the WhatsApp bridge (${bridge}) and remove its start-at-login service.` : undefined,
    config !== null && !bridge ? `• The bridge cannot be stopped from Pi${problem ? `: ${problem}` : ""}.` : undefined,
    config !== null ? `• Delete Pi's WhatsApp settings (${configFile}).` : undefined,
    downloaded ? `• Delete the bridge Pi downloaded (${paths.installDir}).` : undefined,
    bridge && !isInside(paths.installDir, bridge) ? `• Keep your own bridge executable (${bridge}).` : undefined,
    "• Leave your mcp.json files unchanged.",
  ];
  const cancelled = () => ctx.ui.notify("WhatsApp uninstall cancelled. Nothing was changed.", "info");
  if (!(await ctx.ui.confirm("Uninstall WhatsApp from Pi?", plan.filter(Boolean).join("\n")))) return cancelled();

  const purge = bridge ? await choosePurge(ctx, paths.dataDir) : false;
  if (purge === undefined) return cancelled();
  if (bridge) {
    const outcome: Outcome = purge
      ? await purgeInTerminal(ctx, bridge)
      : await runBridgeCommand(bridge, ["uninstall"], { timeoutMs: 60_000 }).then(() => ({ ok: true }), (error: Error) => ({ ok: false, error: error.message }));
    if (!outcome.ok) {
      return ctx.ui.notify(`The WhatsApp bridge could not be uninstalled: ${outcome.error}\nNothing else was changed. Run /whatsapp-uninstall again, or run "${bridge}" uninstall in a terminal.`, "error");
    }
  }

  await forget(); // before deleting the download, which Pi's MCP connection may still be running
  try {
    await rm(configFile, { force: true });
    await rm(paths.installDir, { recursive: true, force: true });
  } catch (error) {
    return ctx.ui.notify(`WhatsApp is disconnected from Pi, but some of its files could not be removed: ${(error as Error).message}\nRun /whatsapp-uninstall again to finish.`, "error");
  }

  const lines = ["WhatsApp was removed from Pi; its tools are no longer available in this session."];
  if (config !== null && !bridge) {
    lines.push(`The bridge could not be stopped from Pi${problem ? ` (${problem})` : ""}. If it is still installed, run "whatsapp-mcp uninstall" in a terminal to stop it and remove its autostart.`);
  }
  if (paths.dataDir && existsSync(paths.dataDir)) lines.push(`Your WhatsApp session, message history and downloads remain in ${paths.dataDir}. Delete that folder to remove them.`);
  else if (purge) lines.push("Your local WhatsApp data was deleted.");
  const server = await findConfiguredServer(paths.agentDir, ctx.cwd);
  if (server) lines.push(`${server.source} still defines a "whatsapp" server, which Pi keeps using. It was left unchanged; remove it yourself if you no longer need it.`);
  ctx.ui.notify([...lines, UNLINK, PACKAGE].join("\n"), config !== null && !bridge ? "warning" : "info");
}
