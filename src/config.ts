import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
