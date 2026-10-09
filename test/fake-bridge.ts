import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Writes an executable stand-in for whatsapp-mcp. `script` is the body of a Node
 * program receiving the command-line arguments as `args` and stdin as `input`.
 * POSIX only: Windows cannot execute a shebang script.
 */
export function fakeBridge(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-whatsapp-fake bridge-"));
  const path = join(dir, "whatsapp-mcp");
  writeFileSync(
    path,
    `#!${process.execPath}
const args = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {});
const main = async () => { ${script} };
main().catch((e) => { console.error(String(e)); process.exit(1); });
`,
  );
  chmodSync(path, 0o755);
  return path;
}

export const STATUS = {
  version: "0.1.0",
  running: true,
  state: "online",
  connected: true,
  linked: true,
  approver_id: "",
  autostart: false,
  data_dir: "/data",
  log_file: "/data/bridge.log",
};
