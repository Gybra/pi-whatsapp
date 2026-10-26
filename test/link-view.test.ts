import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { LinkEvent, LinkProcess } from "../src/types/bridge.ts";
import { renderQRLines, runLinkScreen } from "../src/link-view.ts";

const KEYS = { enter: "\r", escape: "\x1b" };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const QR = ["000000", "011110", "010010", "010010", "011110", "000000"];

function fakeLinks() {
  const runs: { onEvent: (e: LinkEvent) => void; answers: boolean[]; cancelled: boolean; finish: (r: { ok: true } | { ok: false; error: string }) => void }[] = [];
  const start = (onEvent: (e: LinkEvent) => void): LinkProcess => {
    let finish!: (r: { ok: true } | { ok: false; error: string }) => void;
    const done = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => (finish = resolve));
    const run = { onEvent, answers: [] as boolean[], cancelled: false, finish };
    runs.push(run);
    return { answer: (yes) => run.answers.push(yes), cancel: () => { run.cancelled = true; finish({ ok: false, error: "cancelled" }); }, done };
  };
  return { runs, start };
}

function openScreen(mode = "tui", rows = 60) {
  const links = fakeLinks();
  let view: { render(w: number): string[]; handleInput(d: string): void } | undefined;
  let renders = 0;
  const ctx = {
    mode,
    hasUI: mode !== "print",
    ui: {
      custom: (factory: (...a: unknown[]) => typeof view) =>
        new Promise((resolve) => {
          view = factory({ terminal: { rows }, requestRender: () => renders++ }, theme, {}, resolve);
        }),
    },
  };
  const result = runLinkScreen(ctx as never, links.start);
  return { links, result, view: () => view!, renders: () => renders };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("renders QR modules as dark-on-light half blocks", () => {
  const lines = renderQRLines(QR);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(line.startsWith("\x1b[30;47m") && line.endsWith("\x1b[0m"));
    assert.equal(visibleWidth(line), 6);
  }
  assert.equal(lines[1], "\x1b[30;47m █  █ \x1b[0m");
});

test("shows each new QR code and finishes when the phone links", async () => {
  const s = openScreen();
  await flush();
  s.links.runs[0].onEvent({ event: "qr", modules: QR, expires_in: 60 });
  let screen = s.view().render(80).join("\n");
  assert.ok(screen.includes("Linked devices") && screen.includes("\x1b[30;47m"), screen);
  assert.ok(s.renders() > 0, "a new code must trigger a redraw");
  s.links.runs[0].onEvent({ event: "linked", message: "This computer is now linked to WhatsApp." });
  screen = s.view().render(80).join("\n");
  assert.ok(screen.includes("now linked") && !screen.includes("\x1b[30;47m"), "the QR disappears once linked");
  s.links.runs[0].finish({ ok: true });
  assert.equal(await s.result, true);
});

test("asks to compare a passkey code and forwards the answer", async () => {
  const s = openScreen();
  await flush();
  s.links.runs[0].onEvent({ event: "confirm_code", code: "123456", message: "Check" });
  assert.ok(s.view().render(80).join("\n").includes("123456"));
  s.view().handleInput("x");
  assert.deepEqual(s.links.runs[0].answers, [], "other keys do not answer");
  s.view().handleInput("y");
  assert.deepEqual(s.links.runs[0].answers, [true]);
  s.links.runs[0].onEvent({ event: "confirm_code", code: "654321", message: "Check" });
  s.view().handleInput("N");
  assert.deepEqual(s.links.runs[0].answers, [true, false], "N refuses a code that does not match");
});

test("Escape cancels linking and stops the process", async () => {
  const s = openScreen();
  await flush();
  s.view().handleInput(KEYS.escape);
  assert.equal(await s.result, false);
  assert.equal(s.links.runs[0].cancelled, true);
});

test("an expired code can be regenerated with Enter", async () => {
  const s = openScreen();
  await flush();
  s.links.runs[0].finish({ ok: false, error: "the QR code expired before it was scanned; start linking again" });
  await flush();
  assert.ok(s.view().render(80).join("\n").includes("Enter"));
  s.view().handleInput(KEYS.enter);
  await flush();
  assert.equal(s.links.runs.length, 2, "Enter starts a new link with a new code");
  s.links.runs[1].finish({ ok: true });
  assert.equal(await s.result, true);
});

test("explains a terminal too small for the QR code instead of drawing a broken one", async () => {
  const big = Array.from({ length: 60 }, () => "1".repeat(60));
  const narrow = openScreen("tui", 60);
  await flush();
  narrow.links.runs[0].onEvent({ event: "qr", modules: big, expires_in: 60 });
  let screen = narrow.view().render(40);
  assert.ok(screen.join("\n").includes("at least 60 columns"), screen.join("\n"));
  for (const line of screen) assert.ok(visibleWidth(line) <= 40);
  const short = openScreen("tui", 20);
  await flush();
  short.links.runs[0].onEvent({ event: "qr", modules: big, expires_in: 60 });
  screen = short.view().render(100);
  assert.ok(screen.join("\n").includes("rows"), screen.join("\n"));
});

test("needs the interactive TUI", async () => {
  const s = openScreen("rpc");
  assert.equal(await s.result, false);
  assert.equal(s.links.runs.length, 0);
});
