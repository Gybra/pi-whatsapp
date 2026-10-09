import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assetFor, type BridgeRelease } from "../src/install.ts";

const run = promisify(execFile);
const script = new URL("../scripts/update-bridge-release.mjs", import.meta.url).pathname;
const hash = (c: string) => c.repeat(64);

test("writes the pinned checksums from a bridge release's SHA256SUMS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whatsapp-release-"));
  const sums = join(dir, "SHA256SUMS");
  writeFileSync(sums, [
    `${hash("a")}  whatsapp-mcp-darwin-arm64`,
    `${hash("b")}  whatsapp-mcp-linux-amd64`,
    `${hash("c")}  whatsapp-mcp-windows-amd64.exe`,
    "",
  ].join("\n"));
  const out = join(dir, "bridge-release.json");
  await run(process.execPath, [script, "1.4.0", sums, out]);
  const release = JSON.parse(readFileSync(out, "utf8")) as BridgeRelease;
  assert.equal(release.version, "1.4.0");
  assert.deepEqual(assetFor(release, "darwin", "arm64"), { file: "whatsapp-mcp-darwin-arm64", sha256: hash("a") });
  assert.deepEqual(assetFor(release, "win32", "x64"), { file: "whatsapp-mcp-windows-amd64.exe", sha256: hash("c") });
  assert.equal(assetFor(release, "linux", "arm64"), undefined);
});

test("rejects a bad version or checksum file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whatsapp-release-"));
  const sums = join(dir, "SHA256SUMS");
  writeFileSync(sums, `${hash("a")}  whatsapp-mcp-darwin-arm64\n`);
  await assert.rejects(run(process.execPath, [script, "v1.4", sums, join(dir, "out.json")]));
  writeFileSync(sums, "not a checksum line\n");
  await assert.rejects(run(process.execPath, [script, "1.4.0", sums, join(dir, "out.json")]));
});
