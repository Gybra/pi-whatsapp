import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeRelease } from "./types/bridge.ts";

// Each pi-whatsapp release pins the SHA-256 of the matching whatsapp-mcp binaries
// (bridge-release.json, published to npm). The binary comes from GitHub Releases,
// so tampering would need both npm and GitHub to be compromised.

const MAX_BINARY_BYTES = 100 * 1024 * 1024;
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH_NAMES: Partial<Record<string, string>> = { arm64: "arm64", x64: "amd64" };

export function assetFor(release: BridgeRelease, platform: NodeJS.Platform, arch: string) {
  const os = OS_NAMES[platform];
  const cpu = ARCH_NAMES[arch];
  return release.version && os && cpu ? release.assets[`${os}-${cpu}`] : undefined;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * Installs the verified bridge binary into installDir/<version>/ and returns its path.
 * An existing file is reused only if it still matches the pinned checksum.
 */
export async function installBridge(options: {
  installDir: string;
  release: BridgeRelease;
  platform: NodeJS.Platform;
  arch: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { installDir, release, platform, arch, fetchImpl = fetch } = options;
  const asset = assetFor(release, platform, arch);
  if (!asset || !release.version) throw new Error(`No whatsapp-mcp release is available for ${platform}/${arch}`);
  const dir = join(installDir, release.version);
  const target = join(dir, platform === "win32" ? "whatsapp-mcp.exe" : "whatsapp-mcp");
  try {
    if (sha256(await readFile(target)) === asset.sha256) return target;
  } catch {
    // not installed yet
  }
  const url = `https://github.com/Gybra/whatsapp-mcp/releases/download/v${release.version}/${asset.file}`;
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BINARY_BYTES) throw new Error("Download too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BINARY_BYTES) throw new Error("Download too large");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (sha256(data) !== asset.sha256) throw new Error("The downloaded whatsapp-mcp does not match the expected checksum; it was not installed");
  const tmp = join(dir, `.download-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(tmp, data, { mode: 0o700, flag: "wx" });
    await chmod(tmp, 0o755);
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
  return target;
}
