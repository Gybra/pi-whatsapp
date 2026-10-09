import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bridgeDataDir, checkBridgeExecutable, findConfiguredServer, isSameBridge, loadBridgeToken, loadConfig, saveConfig } from "../src/config.ts";

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


async function executable(dir: string, name: string, mode = 0o755): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, mode);
  return path;
}

test("saves and loads the extension config privately and atomically", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "pi-whatsapp-test-")), "agent");
  const path = join(dir, "pi-whatsapp.json");
  assert.equal(await loadConfig(path), null);
  await saveConfig(path, { bridgePath: "/opt/whatsapp mcp/whatsapp-mcp" });
  assert.deepEqual(await loadConfig(path), { bridgePath: "/opt/whatsapp mcp/whatsapp-mcp" });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(saveConfig(path, { bridgePath: "relative/whatsapp-mcp" }));
  for (const bad of ['{"bridgePath":"relative"}', '{"bridgePath":"/x","token":"secret"}', "not json", "[]"]) {
    await writeFile(path, bad);
    await assert.rejects(loadConfig(path), /run \/whatsapp-setup again/, bad);
  }
});

test("accepts only an absolute executable regular file as the bridge", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whatsapp test $(dir)-"));
  assert.equal(await checkBridgeExecutable(await executable(dir, "whatsapp mcp;rm -rf")), undefined, "spaces and shell metacharacters are fine: no shell is used");
  assert.match((await checkBridgeExecutable("whatsapp-mcp")) ?? "", /absolute/);
  assert.match((await checkBridgeExecutable(join(dir, "missing"))) ?? "", /not found/);
  assert.match((await checkBridgeExecutable(dir)) ?? "", /not a file/);
  assert.match((await checkBridgeExecutable(await executable(dir, "plain", 0o644))) ?? "", /not executable/);
});

test("finds an existing whatsapp server in Pi's MCP files without changing them", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-whatsapp-agent-"));
  const project = mkdtempSync(join(tmpdir(), "pi-whatsapp-project-"));
  assert.equal(await findConfiguredServer(agentDir, project), undefined);
  const globalFile = join(agentDir, "mcp.json");
  const globalContent = JSON.stringify({ mcpServers: { whatsapp: { command: "/usr/bin/uv", args: ["run", "main.py"] }, other: {} } });
  await writeFile(globalFile, globalContent);
  assert.deepEqual(await findConfiguredServer(agentDir, project), { source: globalFile, command: "/usr/bin/uv", args: ["run", "main.py"] });
  await mkdir(join(project, ".pi"));
  await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { whatsapp: { command: "/opt/bin/whatsapp-mcp", args: ["mcp"] } } }));
  const found = await findConfiguredServer(agentDir, project);
  assert.equal(found?.source, join(project, ".pi", "mcp.json"), "a project entry overrides the global one");
  assert.ok(found && isSameBridge(found, "/opt/bin/whatsapp-mcp"));
  assert.ok(!isSameBridge({ source: "x", command: "/usr/bin/uv", args: ["mcp"] }, "/opt/bin/whatsapp-mcp"));
  await writeFile(join(project, ".pi", "mcp.json"), "{ broken");
  assert.equal((await findConfiguredServer(agentDir, project))?.source, globalFile, "a malformed file is ignored");
  assert.equal(await readFile(globalFile, "utf8"), globalContent);
});
