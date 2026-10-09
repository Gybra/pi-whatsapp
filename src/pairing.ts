import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { BridgeClient } from "./bridge-client.ts";
import type { SessionSigner } from "./protocol.ts";

const PAIRING_TIMEOUT_MS = 5 * 60_000;

/** Displays a path for copying into a shell; nothing here is ever executed. */
function shellQuote(path: string): string {
  if (/^[A-Za-z0-9/._-]+$/.test(path)) return path;
  return process.platform === "win32" ? `"${path}"` : `'${path.replaceAll("'", `'\\''`)}'`;
}

export function pairingInstructions(signer: SessionSigner, bridgePath: string | undefined): string[] {
  const command = `${bridgePath ? shellQuote(bridgePath) : "whatsapp-mcp"} setup --pair-pi`;
  return [
    "Let this Pi session approve outgoing WhatsApp messages.",
    "",
    "1. In a separate terminal, run:",
    `   ${command}`,
    "2. Paste this public key when asked:",
    `   ${signer.publicKeyB64}`,
    "3. Type yes only if the terminal shows this fingerprint:",
    `   ${signer.approverID}`,
    "",
    "The pairing lasts until Pi quits or reloads.",
  ];
}

/** Polls the bridge until it trusts approverID or signal aborts. Errors are retried until then. */
export async function waitForPairing(client: Pick<BridgeClient, "status">, approverID: string, signal: AbortSignal, intervalMs = 2000): Promise<boolean> {
  while (!signal.aborted) {
    try {
      if ((await client.status(signal)).approver_id === approverID) return true;
    } catch {
      // The bridge may still be starting; keep waiting until the user gives up.
    }
    try {
      await sleep(intervalMs, undefined, { signal });
    } catch {
      return false;
    }
  }
  return false;
}

class PairingView implements Component {
  private readonly lines: string[];
  private readonly theme: Pick<Theme, "fg" | "bold">;
  private readonly cancel: () => void;
  private readonly onDispose: () => void;

  constructor(lines: string[], theme: Pick<Theme, "fg" | "bold">, cancel: () => void, onDispose: () => void) {
    this.lines = lines;
    this.theme = theme;
    this.cancel = cancel;
    this.onDispose = onDispose;
  }

  render(width: number): string[] {
    const body = [...this.lines, "", this.theme.fg("muted", "Waiting for the bridge to confirm… Esc to close.")];
    return [this.theme.fg("accent", this.theme.bold("Pair Pi with WhatsApp")), ...body.flatMap((line) => wrapTextWithAnsi(line, Math.max(width, 10)))].map(
      (line) => truncateToWidth(line, width),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) this.cancel();
  }

  invalidate(): void {}

  dispose(): void {
    this.onDispose();
  }
}

/** Shows the pairing instructions and resolves true once the bridge trusts this session's key. */
export async function runPairing(ctx: ExtensionContext, client: Pick<BridgeClient, "status">, signer: SessionSigner, bridgePath: string | undefined, intervalMs = 2000): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return false;
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(PAIRING_TIMEOUT_MS)]);
  return ctx.ui.custom<boolean>((_tui, theme, _keybindings, done) => {
    let finished = false;
    const finish = (paired: boolean) => {
      if (finished) return;
      finished = true;
      stop.abort();
      done(paired);
    };
    waitForPairing(client, signer.approverID, signal, intervalMs).then(finish);
    return new PairingView(pairingInstructions(signer, bridgePath), theme, () => finish(false), () => stop.abort());
  });
}
