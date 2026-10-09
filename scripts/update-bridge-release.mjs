// Pins the checksums of a whatsapp-mcp release in bridge-release.json, before publishing
// pi-whatsapp to npm. Usage: node scripts/update-bridge-release.mjs 1.2.3 path/to/SHA256SUMS [output]
import { readFileSync, writeFileSync } from "node:fs";

const [version, sumsPath, output = new URL("../bridge-release.json", import.meta.url)] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !sumsPath) {
  console.error("Usage: node scripts/update-bridge-release.mjs <version, e.g. 1.2.3> <SHA256SUMS> [output]");
  process.exit(2);
}
const assets = {};
for (const line of readFileSync(sumsPath, "utf8").split("\n").filter(Boolean)) {
  const match = /^([0-9a-f]{64})  (whatsapp-mcp-(darwin|linux|windows)-(amd64|arm64)(\.exe)?)$/.exec(line);
  if (!match) {
    console.error(`Unexpected line in ${sumsPath}: ${line}`);
    process.exit(1);
  }
  assets[`${match[3]}-${match[4]}`] = { file: match[2], sha256: match[1] };
}
writeFileSync(output, `${JSON.stringify({ version, assets }, null, 2)}\n`);
console.log(`Pinned ${Object.keys(assets).length} binaries of whatsapp-mcp ${version}.`);
