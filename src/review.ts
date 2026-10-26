import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { AttachmentView, ReviewedDraft } from "./types/approval.ts";

const INLINE_TEXT_LIMIT = 64 * 1024;
const KIND_LABEL = { text: "message", file: "file", voice: "voice message" } as const;
// An overlay gets the whole terminal height: in Pi's editor dock the bottom rows would be clipped and PgUp/PgDn taken.
const REVIEW_OVERLAY = { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-left" } } as const;

type ReviewTheme = Pick<Theme, "fg" | "bold" | "inverse">;
type ReviewLine = { text: string; tone?: "title" | "warning" | "muted"; quoted?: boolean };
type PreparedPreview = { inline?: string; path?: string; cleanup(): Promise<void> };

/** Codepoints that render invisibly or change how surrounding text is displayed. */
function isHidden(cp: number): boolean {
  return (
    (cp < 0x20 && cp !== 0x0a && cp !== 0x09) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x061c ||
    cp === 0x200b ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    cp === 0xfeff ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

/** Makes control, terminal and invisible characters visible as ⟨U+XXXX⟩. The sent bytes are unchanged. */
export function escapeReviewText(text: string): { text: string; hidden: number } {
  let out = "";
  let hidden = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp === 0x09) {
      out += "    ";
    } else if (isHidden(cp)) {
      out += `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;
      hidden++;
    } else {
      out += char;
    }
  }
  return { text: out, hidden };
}

type DraftReviewOptions = {
  lines: ReviewLine[];
  theme: ReviewTheme;
  rows: () => number;
  finish: (approved: boolean) => void;
  requestRender: () => void;
  dispose: () => void;
};

/**
 * Full-screen review of one outgoing operation. Cancel has the initial focus, and
 * "Approve and send" becomes selectable only once the end of the content was shown.
 */
export class DraftReview implements Component {
  private readonly options: DraftReviewOptions;
  private offset = 0;
  private pageSize = 1;
  private seenEnd = false;
  private approveFocused = false;

  constructor(options: DraftReviewOptions) {
    this.options = options;
  }

  render(width: number): string[] {
    const { theme, rows } = this.options;
    const wrapWidth = Math.max(width, 10);
    const content = this.layout(wrapWidth);
    const height = rows();
    // Never draw more rows than the terminal has: rows scrolled off-screen would count as seen.
    let withHelp = true;
    let reserve = this.footer(wrapWidth, content.length, content.length, content.length, false, true).length;
    if (height - 2 - reserve < 1) {
      withHelp = false;
      reserve = this.footer(wrapWidth, content.length, content.length, content.length, false, false).length;
    }
    this.pageSize = Math.max(1, height - 2 - reserve);
    const last = Math.max(0, content.length - this.pageSize);
    this.offset = Math.min(Math.max(this.offset, 0), last);
    if (this.offset >= last) this.seenEnd = true;
    const visible = content.slice(this.offset, this.offset + this.pageSize);
    const footer = this.footer(wrapWidth, content.length, this.offset, visible.length, this.seenEnd, withHelp);
    return [theme.fg("accent", theme.bold("Review outgoing WhatsApp message")), ...visible, ...footer, this.buttons()].map((row) =>
      truncateToWidth(row, width),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.options.finish(false);
    if (matchesKey(data, Key.enter)) return this.options.finish(this.approveFocused && this.seenEnd);
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.approveFocused = this.seenEnd && !this.approveFocused;
    } else if (matchesKey(data, Key.up)) {
      this.offset--;
    } else if (matchesKey(data, Key.down)) {
      this.offset++;
    } else if (matchesKey(data, Key.pageUp)) {
      this.offset -= Math.max(1, this.pageSize - 1);
    } else if (matchesKey(data, Key.pageDown)) {
      this.offset += Math.max(1, this.pageSize - 1);
    } else if (matchesKey(data, Key.home)) {
      this.offset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.offset = Number.MAX_SAFE_INTEGER; // clamped on render
    } else {
      return;
    }
    this.options.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.offset += event.wheelDelta; // clamped on render
    return { handled: true };
  }

  invalidate(): void {}

  dispose(): void {
    this.options.dispose();
  }

  private layout(width: number): string[] {
    const { theme } = this.options;
    const rows: string[] = [];
    for (const line of this.options.lines) {
      // The gutter marks message content so it can never pass for interface text.
      const prefix = line.quoted ? theme.fg("borderMuted", "│ ") : "";
      const parts = wrapTextWithAnsi(line.text, line.quoted ? width - 2 : width);
      for (const part of parts.length > 0 ? parts : [""]) {
        rows.push(prefix + (line.tone === "title" ? theme.bold(part) : line.tone ? theme.fg(line.tone, part) : part));
      }
    }
    return rows;
  }

  /** Footer lines are wrapped, never truncated, so the hints stay readable in narrow terminals. */
  private footer(width: number, total: number, offset: number, shown: number, seenEnd: boolean, withHelp: boolean): string[] {
    const { theme } = this.options;
    const lines = [
      seenEnd
        ? theme.fg("muted", `End of content · ${total} lines`)
        : theme.fg("warning", `Lines ${offset + 1}-${offset + shown} of ${total} · scroll to the end to enable Approve`),
    ];
    if (withHelp) lines.push(theme.fg("muted", "↑↓ PgUp PgDn Home End scroll · Tab switch · Enter choose · Esc cancel"));
    return lines.flatMap((line) => wrapTextWithAnsi(line, width));
  }

  private buttons(): string {
    const { theme } = this.options;
    const cancel = this.approveFocused ? "Cancel" : theme.inverse("Cancel");
    const approve = !this.seenEnd ? theme.fg("dim", "Approve and send") : this.approveFocused ? theme.inverse("Approve and send") : "Approve and send";
    return `  ${cancel}   ${approve}`;
  }
}

/**
 * Shows the exact operation the bridge froze and asks the user to approve it.
 * Resolves false on cancel, abort, missing interactive TUI or a preview that does not match.
 */
export async function reviewDraft(ctx: ExtensionContext, draft: ReviewedDraft, signal: AbortSignal, preview?: Uint8Array): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI || signal.aborted) return false;
  const attachment = draft.payload.attachment;
  if (attachment && !matchesAttachment(attachment, preview)) return false;
  const prepared = attachment && preview ? await preparePreview(attachment, preview) : undefined;
  try {
    if (signal.aborted) return false;
    const lines = reviewLines(draft, prepared);
    return await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
      let finished = false;
      const onAbort = () => finish(false);
      const finish = (approved: boolean) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", onAbort);
        done(approved);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      return new DraftReview({
        lines,
        theme,
        rows: () => tui.terminal.rows,
        finish,
        requestRender: () => tui.requestRender(),
        dispose: () => signal.removeEventListener("abort", onAbort),
      });
    }, REVIEW_OVERLAY);
  } finally {
    await prepared?.cleanup();
  }
}

function reviewLines(draft: ReviewedDraft, preview?: PreparedPreview): ReviewLine[] {
  const p = draft.payload;
  const recipient = escapeReviewText(p.recipient_jid);
  const message = escapeReviewText(p.message);
  const inline = preview?.inline === undefined ? undefined : escapeReviewText(preview.inline);
  const lines: ReviewLine[] = [{ text: `Send this ${KIND_LABEL[p.kind]} to: ${recipient.text}`, tone: "title" }];
  let hidden = recipient.hidden + message.hidden + (inline?.hidden ?? 0);
  if (p.attachment) {
    const name = escapeReviewText(p.attachment.name);
    const mime = escapeReviewText(p.attachment.mime);
    hidden += name.hidden + mime.hidden;
    lines.push({ text: `Attachment: ${name.text} · ${mime.text} · ${formatSize(p.attachment.size)}` });
    lines.push({ text: `SHA-256: ${p.attachment.sha256}`, tone: "muted" });
    if (preview?.path) lines.push({ text: `Open and check this exact copy before approving: ${preview.path}`, tone: "warning" });
  }
  if (hidden > 0) {
    lines.push({ text: `⚠ Contains ${hidden} hidden or control characters, shown as ⟨U+…⟩. Check them before approving.`, tone: "warning" });
  }
  lines.push({ text: "" }, { text: p.kind === "text" ? "Message:" : "Caption:", tone: "muted" });
  if (p.message === "") lines.push({ text: "(no caption)", tone: "muted" });
  for (const line of p.message === "" ? [] : message.text.split("\n")) lines.push({ text: line, quoted: true });
  if (inline) {
    lines.push({ text: "" }, { text: "Attachment content:", tone: "muted" });
    for (const line of inline.text.split("\n")) lines.push({ text: line, quoted: true });
  }
  return lines;
}

function matchesAttachment(attachment: AttachmentView, preview: Uint8Array | undefined): preview is Uint8Array {
  return preview !== undefined && preview.length === attachment.size && createHash("sha256").update(preview).digest("hex") === attachment.sha256;
}

/** Small plain-text files are shown inline; anything else is written to a private copy the user opens. */
async function preparePreview(attachment: AttachmentView, bytes: Uint8Array): Promise<PreparedPreview> {
  if (attachment.mime === "text/plain" && bytes.length <= INLINE_TEXT_LIMIT) {
    try {
      return { inline: new TextDecoder("utf-8", { fatal: true }).decode(bytes), cleanup: async () => {} };
    } catch {
      // Not UTF-8: review it as a file instead.
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-whatsapp-"));
  const path = join(dir, safeFileName(attachment.name));
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function safeFileName(name: string): string {
  const base = Array.from(basename(name.replaceAll("\\", "/")))
    .filter((char) => !isHidden(char.codePointAt(0)!))
    .join("")
    .trim()
    .slice(0, 100);
  return base === "" || base === "." || base === ".." ? "attachment" : base;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
