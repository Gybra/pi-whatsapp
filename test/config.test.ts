import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bridgeDataDir, loadBridgeToken } from "../src/config.ts";

const TOKEN = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

test("resolves the bridge data directory like the Go bridge", () => {
  assert.equal(bridgeDataDir("darwin", {}, "/home/ada"), join("/home/ada", "Library", "Application Support", "whatsapp-mcp"));
  assert.equal(bridgeDataDir("linux", {}, "/home/ada"), join("/home/ada", ".local", "share", "whatsapp-mcp"));
  assert.equal(bridgeDataDir("linux", { XDG_DATA_HOME: "/data/xdg" }, "/home/ada"), join("/data/xdg", "whatsapp-mcp"));
  assert.equal(bridgeDataDir("linux", { XDG_DATA_HOME: "relative" }, "/home/ada"), join("/home/ada", ".local", "share", "whatsapp-mcp"));
  assert.throws(() => bridgeDataDir("win32", {}, "/home/ada"));
  assert.throws(() => bridgeDataDir("darwin", {}, "relative"));
});

function dataDir(content: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-whatsapp-test-"));
  writeFileSync(join(dir, "api-token"), content, { mode });
  chmodSync(join(dir, "api-token"), mode);
  return dir;
}

test("loads a private API token", async () => {
  assert.deepEqual(Buffer.from(await loadBridgeToken(dataDir(TOKEN))), Buffer.from(TOKEN, "hex"));
});

test("refuses tokens that are malformed, shared or redirected", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(loadBridgeToken(dataDir(TOKEN + "\n")), /not a whatsapp-mcp API token/);
  await assert.rejects(loadBridgeToken(dataDir("short")), /not a whatsapp-mcp API token/);
  await assert.rejects(loadBridgeToken(dataDir(TOKEN, 0o644)), /not a private file/);
  const target = dataDir(TOKEN);
  const linked = mkdtempSync(join(tmpdir(), "pi-whatsapp-test-"));
  symlinkSync(join(target, "api-token"), join(linked, "api-token"));
  await assert.rejects(loadBridgeToken(linked), /not a private file/);
  await assert.rejects(loadBridgeToken(mkdtempSync(join(tmpdir(), "pi-whatsapp-test-"))), /ENOENT/);
});
