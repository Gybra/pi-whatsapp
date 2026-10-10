import { execFile, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

// Runs the installed whatsapp-mcp executable directly, never through a shell.

const STATES = ["stopped", "unpaired", "connecting", "online", "offline", "action_required"] as const;

export type BridgeStatus = {
  version: string;
  running: boolean;
  state: (typeof STATES)[number];
  connected: boolean;
  linked: boolean;
  approver_id: string;
  autostart: boolean;
  data_dir: string;
  log_file: string;
};

export type LinkEvent = { event: "qr"; modules: string[]; expires_in: number } | { event: "notice" | "linked"; message: string } | { event: "confirm_code"; code: string; message: string };

export type LinkProcess = {
  /** Answers a confirm_code event. */
  answer(confirmed: boolean): void;
  cancel(): void;
  done: Promise<{ ok: true } | { ok: false; error: string }>;
};

export class BridgeCommandError extends Error {}

/** The bridge prints errors as "Error: <message>"; keep just the message. */
function bridgeMessage(stderr: string): string {
  const line = stderr.trim().split("\n").at(-1) ?? "";
  return line.replace(/^Error:\s*/, "").slice(0, 500) || "whatsapp-mcp failed";
}

export function runBridgeCommand(bridgePath: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bridgePath, args, { timeout: options.timeoutMs ?? 30_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.killed || error.signal) return reject(new BridgeCommandError(`whatsapp-mcp ${args[0]} did not respond`));
      reject(new BridgeCommandError(bridgeMessage(stderr)));
    });
    child.stdin?.end(options.input ?? "");
  });
}

/**
 * Runs the bridge on the terminal itself, for commands that confirm only on a real
 * terminal, such as `uninstall --purge`. Blocks until it exits; stderr is kept for the error.
 */
export function runBridgeInTerminal(bridgePath: string, args: string[]): { ok: true } | { ok: false; error: string } {
  const result = spawnSync(bridgePath, args, { stdio: ["inherit", "inherit", "pipe"] });
  if (result.error) return { ok: false, error: result.error.message };
  return result.status === 0 ? { ok: true } : { ok: false, error: bridgeMessage(result.stderr.toString()) };
}

function parseStatus(text: string): BridgeStatus {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BridgeCommandError("whatsapp-mcp returned an unreadable status");
  }
  const valid =
    typeof s === "object" && s !== null &&
    typeof s.version === "string" && typeof s.running === "boolean" && STATES.includes(s.state as BridgeStatus["state"]) &&
    typeof s.connected === "boolean" && typeof s.linked === "boolean" && typeof s.autostart === "boolean" &&
    typeof s.approver_id === "string" && /^([0-9a-f]{64})?$/.test(s.approver_id) &&
    typeof s.data_dir === "string" && typeof s.log_file === "string";
  if (!valid) throw new BridgeCommandError("whatsapp-mcp returned an unexpected status");
  return s as BridgeStatus;
}

export async function bridgeStatus(bridgePath: string): Promise<BridgeStatus> {
  return parseStatus(await runBridgeCommand(bridgePath, ["status", "--json"], { timeoutMs: 15_000 }));
}

/** Trusts this Pi session's public key to approve messages. Returns the bridge's fingerprint of it. */
export async function pairPi(bridgePath: string, publicKeyB64: string): Promise<string> {
  const out = await runBridgeCommand(bridgePath, ["pair-pi"], { input: publicKeyB64 + "\n" });
  try {
    const id = (JSON.parse(out) as { approver_id?: unknown }).approver_id;
    if (typeof id === "string" && /^[0-9a-f]{64}$/.test(id)) return id;
  } catch {
    // reported below
  }
  throw new BridgeCommandError("whatsapp-mcp did not confirm the pairing");
}

function parseLinkEvent(line: string): LinkEvent | undefined {
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    const modules = e.modules;
    if (e.event === "qr" && Array.isArray(modules) && modules.length > 0 && modules.length <= 200 &&
      modules.every((row) => typeof row === "string" && row.length === modules.length && /^[01]+$/.test(row))) {
      return { event: "qr", modules: modules as string[], expires_in: typeof e.expires_in === "number" ? e.expires_in : 0 };
    }
    if ((e.event === "notice" || e.event === "linked") && typeof e.message === "string") return { event: e.event, message: e.message.slice(0, 300) };
    if (e.event === "confirm_code" && typeof e.code === "string" && /^[A-Za-z0-9-]{1,32}$/.test(e.code)) {
      return { event: "confirm_code", code: e.code, message: typeof e.message === "string" ? e.message.slice(0, 300) : "" };
    }
  } catch {
    // not an event
  }
  return undefined;
}

/** Runs `whatsapp-mcp link --json`, passing each valid event to onEvent. */
export function startLink(bridgePath: string, onEvent: (event: LinkEvent) => void): LinkProcess {
  const child = spawn(bridgePath, ["link", "--json"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = parseLinkEvent(line);
    if (event) onEvent(event);
  });
  const done = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: bridgeMessage(stderr) }));
  });
  return {
    answer: (confirmed) => child.stdin.write(confirmed ? "yes\n" : "no\n"),
    cancel: () => child.kill(),
    done,
  };
}
