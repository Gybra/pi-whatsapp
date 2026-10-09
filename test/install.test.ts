import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assetFor, installBridge, type BridgeRelease } from "../src/install.ts";

const binary = Buffer.from("#!/bin/sh\necho whatsapp-mcp\n");
const sha256 = createHash("sha256").update(binary).digest("hex");
const release: BridgeRelease = {
  version: "1.2.3",
  assets: { "darwin-arm64": { file: "whatsapp-mcp-darwin-arm64", sha256 }, "windows-amd64": { file: "whatsapp-mcp-windows-amd64.exe", sha256 } },
};

function fakeFetch(body: Uint8Array | null, status = 200) {
  const urls: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(body as BodyInit | null, { status });
  };
  return { fetchImpl: fetchImpl as typeof fetch, urls };
}

test("maps the platform to the release asset", () => {
  assert.equal(assetFor(release, "darwin", "arm64")?.file, "whatsapp-mcp-darwin-arm64");
  assert.equal(assetFor(release, "win32", "x64")?.file, "whatsapp-mcp-windows-amd64.exe");
  assert.equal(assetFor(release, "linux", "x64"), undefined);
  assert.equal(assetFor({ version: null, assets: {} }, "darwin", "arm64"), undefined);
});

test("downloads, verifies and installs the bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whatsapp-install-"));
  const { fetchImpl, urls } = fakeFetch(binary);
  const path = await installBridge({ installDir: dir, release, platform: "darwin", arch: "arm64", fetchImpl });
  assert.deepEqual(urls, ["https://github.com/Gybra/whatsapp-mcp/releases/download/v1.2.3/whatsapp-mcp-darwin-arm64"]);
  assert.equal(path, join(dir, "1.2.3", "whatsapp-mcp"));
  assert.deepEqual(readFileSync(path), binary);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o755);
  // Reinstalling the same version reuses the verified file.
  const again = fakeFetch(binary);
  assert.equal(await installBridge({ installDir: dir, release, platform: "darwin", arch: "arm64", fetchImpl: again.fetchImpl }), path);
  assert.equal(again.urls.length, 0);
});

test("refuses a download whose checksum does not match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whatsapp-install-"));
  const { fetchImpl } = fakeFetch(Buffer.from("tampered"));
  await assert.rejects(installBridge({ installDir: dir, release, platform: "darwin", arch: "arm64", fetchImpl }), /checksum/);
  assert.equal(existsSync(join(dir, "1.2.3", "whatsapp-mcp")), false);
  assert.deepEqual(readdirSync(join(dir, "1.2.3")), [], "no partial file left behind");
});

test("refuses failed, oversized and unsupported downloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whatsapp-install-"));
  await assert.rejects(installBridge({ installDir: dir, release, platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(null, 404).fetchImpl }), /404/);
  await assert.rejects(
    installBridge({ installDir: dir, release, platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(new Uint8Array(101 * 1024 * 1024)).fetchImpl }),
    /too large/,
  );
  await assert.rejects(installBridge({ installDir: dir, release, platform: "linux", arch: "x64", fetchImpl: fakeFetch(binary).fetchImpl }), /No whatsapp-mcp release/);
  // A file already at the target with other content is replaced only by a verified download, never trusted.
  const tampered = mkdtempSync(join(tmpdir(), "pi-whatsapp-install-"));
  await installBridge({ installDir: tampered, release, platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(binary).fetchImpl });
  const target = join(tampered, "1.2.3", "whatsapp-mcp");
  (await import("node:fs")).writeFileSync(target, "replaced by someone");
  const refetch = fakeFetch(binary);
  await installBridge({ installDir: tampered, release, platform: "darwin", arch: "arm64", fetchImpl: refetch.fetchImpl });
  assert.equal(refetch.urls.length, 1);
  assert.deepEqual(readFileSync(target), binary);
});

test("the packaged release manifest is well formed", () => {
  const manifest = JSON.parse(readFileSync(new URL("../bridge-release.json", import.meta.url), "utf8")) as BridgeRelease;
  assert.ok(manifest.version === null || /^\d+\.\d+\.\d+$/.test(manifest.version));
  for (const [key, asset] of Object.entries(manifest.assets)) {
    assert.match(key, /^(darwin|linux|windows)-(amd64|arm64)$/);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.match(asset.file, /^whatsapp-mcp-[a-z0-9-]+(\.exe)?$/);
  }
});
