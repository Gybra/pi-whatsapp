import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ConfiguredServer } from "./types.ts";

const APP_NAME = "whatsapp-mcp";

/** The bridge's per-user data directory, resolved exactly as the Go bridge does. */
export function bridgeDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === "win32") {
    if (!env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)) throw new Error("LOCALAPPDATA is not set to an absolute path");
    return join(env.LOCALAPPDATA, APP_NAME);
  }
  if (!isAbsolute(home)) throw new Error("the home directory is not an absolute path");
  if (platform === "darwin") return join(home, "Library", "Application Support", APP_NAME);
  if (env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)) return join(env.XDG_DATA_HOME, APP_NAME);
  return join(home, ".local", "share", APP_NAME);
}

/** Reads the bridge's API token, refusing files another user could have written or read. */
export async function loadBridgeToken(dataDir = bridgeDataDir()): Promise<Uint8Array> {
  const path = join(dataDir, "api-token");
  const info = await lstat(path);
  const foreign = process.getuid !== undefined && info.uid !== process.getuid();
  if (!info.isFile() || foreign || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error(`${path} is not a private file owned by you`);
  }
  const text = await readFile(path, "utf8");
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path} is not a whatsapp-mcp API token`);
  return Buffer.from(text, "hex");
}

type ExtensionConfig = { bridgePath: string };

export function configPath(agentDir: string): string {
  return join(agentDir, "pi-whatsapp.json");
}

/** Reads this extension's own settings file. It never holds tokens or keys. */
export async function loadConfig(path: string): Promise<ExtensionConfig | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (Object.keys(value).join() === "bridgePath" && typeof value.bridgePath === "string" && isAbsolute(value.bridgePath)) {
      return { bridgePath: value.bridgePath };
    }
  } catch {
    // reported below
  }
  throw new Error(`${path} is not a valid pi-whatsapp config; run /whatsapp-setup again`);
}

export async function saveConfig(path: string, config: ExtensionConfig): Promise<void> {
  if (!isAbsolute(config.bridgePath)) throw new Error("the bridge path must be absolute");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ bridgePath: config.bridgePath }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

/** Describes why path cannot be the bridge executable, or returns undefined if it can. */
export async function checkBridgeExecutable(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return "the path must be absolute";
  try {
    if (!(await stat(path)).isFile()) return `${path} is not a file`;
    await access(path, constants.X_OK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? `${path} was not found` : `${path} is not executable`;
  }
  return undefined;
}

/** Finds a "whatsapp" server in Pi's MCP files (project first, as Pi does). Read-only. */
export async function findConfiguredServer(agentDir: string, cwd: string): Promise<ConfiguredServer | undefined> {
  for (const source of [join(cwd, ".pi", "mcp.json"), join(agentDir, "mcp.json")]) {
    try {
      const servers = (JSON.parse(await readFile(source, "utf8")) as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> }).mcpServers;
      const entry = servers?.whatsapp;
      if (entry && typeof entry === "object") return { source, command: entry.command, args: entry.args };
    } catch {
      // Missing or malformed files are Pi's to report.
    }
  }
  return undefined;
}

export function isSameBridge(server: ConfiguredServer, bridgePath: string): boolean {
  return server.command === bridgePath && Array.isArray(server.args) && server.args.length === 1 && server.args[0] === "mcp";
}
