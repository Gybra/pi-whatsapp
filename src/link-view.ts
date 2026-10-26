import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { LinkEvent, LinkProcess } from "./types/bridge.ts";

type Phase =
  | { kind: "starting" }
  | { kind: "qr"; modules: string[]; expiresIn: number }
  | { kind: "confirm"; code: string }
  | { kind: "linked"; message: string }
  | { kind: "failed"; error: string };

/** Draws QR modules two rows per line, dark on light whatever the terminal theme, so phones can scan it. */
export function renderQRLines(modules: string[]): string[] {
  const lines: string[] = [];
  for (let y = 0; y < modules.length; y += 2) {
    let line = "";
    for (let x = 0; x < modules[y].length; x++) {
      const top = modules[y][x] === "1";
      const bottom = modules[y + 1]?.[x] === "1";
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines;
}

class LinkScreen implements Component {
  phase: Phase = { kind: "starting" };
  notice = "";

  private readonly theme: Pick<Theme, "fg" | "bold">;
  private readonly rows: () => number;
  private readonly keys: (data: string) => void;

  constructor(theme: Pick<Theme, "fg" | "bold">, rows: () => number, keys: (data: string) => void) {
    this.theme = theme;
    this.rows = rows;
    this.keys = keys;
  }

  render(width: number): string[] {
    const t = this.theme;
    const text: string[] = [];
    let qr: string[] = [];
    switch (this.phase.kind) {
      case "starting":
        text.push("Connecting to WhatsApp…");
        break;
      case "qr": {
        const size = this.phase.modules.length;
        const height = Math.ceil(size / 2);
        if (width < size) text.push(t.fg("warning", `Make the terminal at least ${size} columns wide to show the QR code.`));
        else if (this.rows() < height + 6) text.push(t.fg("warning", `Make the terminal at least ${height + 6} rows tall to show the QR code.`));
        else qr = renderQRLines(this.phase.modules);
        text.push(`On your phone open WhatsApp › Settings › Linked devices › Link a device, and scan this code. A new code appears every ${this.phase.expiresIn} s.`);
        break;
      }
      case "confirm":
        text.push(`WhatsApp shows a code: ${t.bold(this.phase.code)}`, "Press Y if your phone shows the same code, N if it does not.");
        break;
      case "linked":
        text.push(t.fg("success", this.phase.message), "Receiving recent messages…");
        break;
      case "failed":
        text.push(t.fg("error", `Linking failed: ${this.phase.error}`), "Press Enter to try again with a new code, or Esc to close.");
        break;
    }
    if (this.notice) text.push(t.fg("warning", this.notice));
    if (this.phase.kind !== "failed") text.push(t.fg("muted", "Esc to cancel"));
    const wrapped = text.flatMap((line) => wrapTextWithAnsi(line, Math.max(width, 10)));
    return [t.fg("accent", t.bold("Link WhatsApp")), ...qr, ...wrapped].map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    this.keys(data);
  }

  invalidate(): void {}
}

/**
 * Shows the QR codes of `whatsapp-mcp link` inside Pi until the phone links this
 * computer. Resolves true once linked, false when cancelled or outside the TUI.
 */
export async function runLinkScreen(ctx: ExtensionContext, start: (onEvent: (event: LinkEvent) => void) => LinkProcess): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return false;
  return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
    let current: LinkProcess | undefined;
    let finished = false;
    const finish = (linked: boolean) => {
      if (finished) return;
      finished = true;
      done(linked);
    };
    const onEvent = (event: LinkEvent) => {
      if (event.event === "qr") screen.phase = { kind: "qr", modules: event.modules, expiresIn: event.expires_in };
      else if (event.event === "confirm_code") screen.phase = { kind: "confirm", code: event.code };
      else if (event.event === "linked") screen.phase = { kind: "linked", message: event.message };
      else screen.notice = event.message;
      tui.requestRender();
    };
    const run = () => {
      screen.phase = { kind: "starting" };
      screen.notice = "";
      const link = start(onEvent);
      current = link;
      link.done.then((result) => {
        if (current !== link || finished) return;
        if (result.ok) return finish(true);
        screen.phase = { kind: "failed", error: result.error };
        tui.requestRender();
      });
    };
    const keys = (data: string) => {
      const key = data.toLowerCase();
      if (data === "\x1b") {
        current?.cancel();
        finish(false);
      } else if (screen.phase.kind === "confirm" && (key === "y" || key === "n")) {
        current?.answer(key === "y");
        screen.phase = { kind: "starting" };
        tui.requestRender();
      } else if (screen.phase.kind === "failed" && (data === "\r" || data === "\n")) {
        run();
        tui.requestRender();
      }
    };
    const screen = new LinkScreen(theme, () => tui.terminal.rows, keys);
    run();
    return screen;
  });
}
