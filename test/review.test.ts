import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSessionSigner } from "../src/approval.ts";
import { decodeDraft } from "../src/protocol.ts";
import type { ReviewedDraft } from "../src/types/approval.ts";
import { DraftReview, escapeReviewText, reviewDraft } from "../src/review.ts";
import { textPayload, wireFor } from "./helpers.ts";

const NOW = 1_800_000_000;
const KEYS = { enter: "\r", escape: "\x1b", tab: "\t", down: "\x1b[B", pageDown: "\x1b[6~", end: "\x1b[F" };
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => `[${text}]` };

function draftWith(overrides: Record<string, unknown>): ReviewedDraft {
  const signer = createSessionSigner();
  return decodeDraft(wireFor(textPayload(overrides), signer.publicKeyB64), signer, NOW);
}

function fileDraft(name: string, mime: string, content: Uint8Array, message = ""): ReviewedDraft {
  const sha256 = createHash("sha256").update(content).digest("hex");
  return draftWith({ kind: "file", message, attachment: { id: name, name, mime, size: content.length, sha256 } });
}

/** Runs reviewDraft with a fake Pi UI and returns the live review component. */
function startReview(draft: ReviewedDraft, options: { mode?: string; preview?: Uint8Array; rows?: number; signal?: AbortSignal } = {}) {
  let view: (DraftReview & { dispose?(): void }) | undefined;
  let customCalls = 0;
  let customOptions: unknown;
  let markOpened: (view: DraftReview) => void = () => {};
  const opened = new Promise<DraftReview>((resolve) => (markOpened = resolve));
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.mode !== "print" && options.mode !== "json",
    ui: {
      custom: (factory: (...args: unknown[]) => unknown, customOpts?: unknown) =>
        new Promise((resolve) => {
          customCalls++;
          customOptions = customOpts;
          view = factory({ terminal: { rows: options.rows ?? 24 }, requestRender() {} }, plainTheme, {}, resolve) as typeof view;
          markOpened(view!);
        }),
    },
  };
  const result = reviewDraft(ctx as never, draft, options.signal ?? new AbortController().signal, options.preview);
  return { result, view: () => view!, opened, customCalls: () => customCalls, customOptions: () => customOptions };
}

function renderAll(view: DraftReview, width: number): string[] {
  const seen: string[] = [];
  for (let i = 0; i < 10_000; i++) {
    const lines = view.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
    seen.push(...lines);
    if (!lines.join(" ").includes("to enable Approve")) break; // the hint may wrap
    view.handleInput(KEYS.pageDown);
  }
  return seen;
}

test("escapes control, terminal and invisible characters without losing them", () => {
  const { text, hidden } = escapeReviewText("a\x1b]8;;http://x\x07b\u202Ec\u200Bd\r\ne\tf\u{E0041}");
  assert.equal(text, "a⟨U+001B⟩]8;;http://x⟨U+0007⟩b⟨U+202E⟩c⟨U+200B⟩d⟨U+000D⟩\ne    f⟨U+E0041⟩");
  assert.equal(hidden, 6);
  assert.deepEqual(escapeReviewText("Ciao 👨‍👩‍👧 ✓ è"), { text: "Ciao 👨‍👩‍👧 ✓ è", hidden: 0 });
});

test("shows the recipient, the kind and every line of a 32 KiB message", async () => {
  const words = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ");
  const message = (words + " END-OF-MESSAGE").slice(-32 * 1024);
  const { view } = startReview(draftWith({ message }), { rows: 20 });
  const screen = renderAll(view(), 40).join("\n");
  assert.ok(screen.includes("12025550123@s.whatsapp.net"));
  assert.ok(screen.includes("END-OF-MESSAGE"), "the tail of the message must be reachable");
  for (const word of ["w3999", message.split(" ")[1]]) assert.ok(screen.includes(word), word);
});

test("cancel is the default and approval needs a deliberate choice", async () => {
  const cancelled = startReview(draftWith({ message: "hi" }));
  cancelled.view().render(80);
  cancelled.view().handleInput(KEYS.enter);
  assert.equal(await cancelled.result, false);

  const approved = startReview(draftWith({ message: "hi" }));
  approved.view().render(80);
  approved.view().handleInput(KEYS.tab);
  approved.view().handleInput(KEYS.enter);
  assert.equal(await approved.result, true);

  const escaped = startReview(draftWith({ message: "hi" }));
  escaped.view().render(80);
  escaped.view().handleInput(KEYS.tab);
  escaped.view().handleInput(KEYS.escape);
  assert.equal(await escaped.result, false);
});

test("approval stays disabled until the end of the content was shown", async () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const review = startReview(draftWith({ message: long }), { rows: 12 });
  review.view().render(60);
  review.view().handleInput(KEYS.tab);
  const screen = review.view().render(60);
  assert.ok(screen.some((line) => line.includes("[Cancel]")) && screen.some((line) => line.includes("to enable Approve")), "focus stays on Cancel");
  review.view().handleInput(KEYS.end);
  assert.ok(review.view().render(60).some((line) => line.includes("line 199")));
  review.view().handleInput(KEYS.tab);
  review.view().handleInput(KEYS.enter);
  assert.equal(await review.result, true);
});

test("opens as a full-terminal overlay so the editor dock cannot clip the buttons", () => {
  const review = startReview(draftWith({ message: "hi" }));
  assert.deepEqual(review.customOptions(), {
    overlay: true,
    overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-left" },
  });
});

test("the mouse wheel scrolls the content and can reach the end", async () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const review = startReview(draftWith({ message: long }), { rows: 12 });
  review.view().render(60);
  const wheel = (wheelDelta: number) => review.view().handleMouse!({ type: "wheel", wheelDelta } as never);
  assert.deepEqual(wheel(3), { handled: true });
  assert.ok(review.view().render(60).some((line) => line.includes("line 3")));
  assert.equal(review.view().handleMouse!({ type: "press" } as never), undefined, "clicks are left to Pi");
  wheel(1000);
  assert.ok(review.view().render(60).some((line) => line.includes("line 199")));
  review.view().handleInput(KEYS.tab);
  review.view().handleInput(KEYS.enter);
  assert.equal(await review.result, true);
});

test("message text cannot inject terminal sequences or impersonate the buttons", async () => {
  const message = "\x1b]8;;http://attacker\x07click\x1b]8;;\x07\n\x1b[2J\n[Approve and send]\n\u202Etxt.exe";
  const { view, result } = startReview(draftWith({ message }));
  const lines = view().render(80);
  const screen = lines.join("\n");
  assert.ok(!screen.includes("\x1b]8"), "no OSC 8 hyperlink from content");
  assert.ok(!screen.includes("\x1b[2J"), "no screen clear from content");
  assert.ok(!screen.includes("\u202E"), "no live bidi override");
  assert.ok(screen.includes("⟨U+202E⟩") && /6 hidden or control characters/.test(screen));
  const impostor = lines.find((line) => line.includes("Approve and send") && !line.includes("Cancel"));
  assert.ok(impostor?.startsWith("│ "), "content lines are always marked with the gutter");
  view().handleInput(KEYS.escape);
  assert.equal(await result, false);
});

test("renders within narrow, short and resized terminals, including wide characters", () => {
  const message = "漢字テキスト 👨‍👩‍👧 emoji ".repeat(40) + "x".repeat(300);
  const { view } = startReview(draftWith({ message }));
  for (const width of [80, 40, 24, 120]) renderAll(view(), width);
  for (const rows of [5, 8, 24]) {
    const short = startReview(draftWith({ message }), { rows });
    assert.ok(short.view().render(30).length <= rows, `screen taller than ${rows} rows`);
  }
});

test("denies without an interactive TUI", async () => {
  for (const mode of ["rpc", "print", "json"]) {
    const review = startReview(draftWith({ message: "hi" }), { mode });
    assert.equal(await review.result, false, mode);
    assert.equal(review.customCalls(), 0, `${mode} must not open a dialog`);
  }
});

test("an abort or deadline cancels an open review", async () => {
  const controller = new AbortController();
  const review = startReview(draftWith({ message: "hi" }), { signal: controller.signal });
  review.view().render(80);
  controller.abort();
  assert.equal(await review.result, false);

  const aborted = new AbortController();
  aborted.abort();
  const early = startReview(draftWith({ message: "hi" }), { signal: aborted.signal });
  assert.equal(await early.result, false);
  assert.equal(early.customCalls(), 0);
});

test("text attachments are shown inline from the frozen bytes", async () => {
  const content = Buffer.from("Quarterly numbers\n\x1b[31mred\n");
  const review = startReview(fileDraft("notes.txt", "text/plain", content, "see notes"), { preview: content });
  const screen = renderAll(await review.opened, 80).join("\n");
  assert.ok(screen.includes("Quarterly numbers") && screen.includes("⟨U+001B⟩[31mred") && screen.includes("see notes"));
  review.view().handleInput(KEYS.escape);
  assert.equal(await review.result, false);
});

test("other attachments are reviewed through a private exact copy that is removed afterwards", async () => {
  const content = Buffer.from("%PDF-1.4 exact bytes");
  const review = startReview(fileDraft("../../report.pdf", "application/pdf", content), { preview: content });
  const screen = renderAll(await review.opened, 200).join("\n");
  const path = /Open and check this exact copy before approving: (\S+)/.exec(screen)?.[1];
  assert.ok(path, screen);
  assert.ok(path.endsWith("report.pdf") && !path.includes(".."));
  assert.deepEqual(readFileSync(path), content);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  review.view().handleInput(KEYS.tab);
  review.view().handleInput(KEYS.enter);
  assert.equal(await review.result, true);
  assert.equal(existsSync(path), false, "the private copy is deleted after the decision");
});

test("refuses an attachment preview that differs from the reviewed hash", async () => {
  const content = Buffer.from("%PDF-1.4 exact bytes");
  for (const preview of [Buffer.from("%PDF-1.4 other bytes"), content.subarray(1), undefined]) {
    const review = startReview(fileDraft("report.pdf", "application/pdf", content), { preview });
    assert.equal(await review.result, false);
    assert.equal(review.customCalls(), 0);
  }
});
