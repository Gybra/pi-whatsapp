import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { bridgeStatus, BridgeCommandError, pairPi, runBridgeCommand, runBridgeInTerminal, startLink, type LinkEvent } from "../src/bridge-cli.ts";
import { fakeBridge, STATUS } from "./fake-bridge.ts";

const posix = { skip: process.platform === "win32" };

test("runs the bridge without a shell and returns stdout", posix, async () => {
  const bridge = fakeBridge(`console.log(JSON.stringify(args))`);
  assert.equal(await runBridgeCommand(bridge, ["status", "--json; rm -rf ~"]), '["status","--json; rm -rf ~"]\n');
});

test("reports the bridge's error message, without stack noise", posix, async () => {
  const bridge = fakeBridge(`console.error("Error: the bridge is running; stop it first"); process.exit(1)`);
  await assert.rejects(runBridgeCommand(bridge, ["link"]), (e: unknown) => e instanceof BridgeCommandError && e.message === "the bridge is running; stop it first");
});

test("reports a bridge that exits before reading its input, without crashing", posix, async () => {
  const bridge = fakeBridge(`console.error("Error: the bridge did not stop"); process.exit(1)`);
  // Larger than a pipe buffer, so the write is still pending when the bridge exits.
  await assert.rejects(runBridgeCommand(bridge, ["uninstall"], { input: "x".repeat(4 * 1024 * 1024) }), /the bridge did not stop/);
});

test("times out a hanging command", posix, async () => {
  const bridge = fakeBridge(`await new Promise(() => setInterval(() => {}, 1000))`);
  await assert.rejects(runBridgeCommand(bridge, ["status"], { timeoutMs: 200 }), /did not respond/);
});

test("runs a command on the terminal and reports its error", posix, () => {
  assert.deepEqual(runBridgeInTerminal(fakeBridge(`process.exit(args.join(" ") === "uninstall --purge" ? 0 : 3)`), ["uninstall", "--purge"]), { ok: true });
  const failing = fakeBridge(`console.error("Error: --purge needs an interactive terminal to confirm"); process.exit(1)`);
  assert.deepEqual(runBridgeInTerminal(failing, ["uninstall", "--purge"]), { ok: false, error: "--purge needs an interactive terminal to confirm" });
  assert.equal(runBridgeInTerminal("/nonexistent/whatsapp-mcp", []).ok, false);
});

test("parses and validates status", posix, async () => {
  assert.deepEqual(await bridgeStatus(fakeBridge(`console.log(JSON.stringify(${JSON.stringify(STATUS)}))`)), STATUS);
  for (const bad of [{ ...STATUS, running: "yes" }, { ...STATUS, state: "hacked" }, { ...STATUS, approver_id: "x" }, "not json"]) {
    const bridge = fakeBridge(`console.log(${JSON.stringify(typeof bad === "string" ? bad : JSON.stringify(bad))})`);
    await assert.rejects(bridgeStatus(bridge), BridgeCommandError, JSON.stringify(bad));
  }
});

test("pairs by passing the public key on stdin", posix, async () => {
  const bridge = fakeBridge(`
    process.stdin.on("end", () => {
      if (args.join(" ") !== "pair-pi" || input.trim() !== "PUBKEY=") process.exit(3);
      console.log(JSON.stringify({ approver_id: "a".repeat(64) }));
    });`);
  assert.equal(await pairPi(bridge, "PUBKEY="), "a".repeat(64));
  await assert.rejects(pairPi(fakeBridge(`console.log("{}")`), "PUBKEY="), BridgeCommandError);
});

test("streams link events and answers confirmation codes", posix, async () => {
  const bridge = fakeBridge(`
    const say = (e) => console.log(JSON.stringify(e));
    say({ event: "qr", modules: ["0000", "0110", "0110", "0000"], expires_in: 60 });
    say({ event: "confirm_code", code: "123456", message: "Check" });
    process.stdin.on("data", (d) => {
      if (String(d).trim() === "yes") { say({ event: "linked", message: "Linked" }); process.exit(0); }
      console.error("Error: cancelled"); process.exit(1);
    });`);
  const events: LinkEvent[] = [];
  const link = startLink(bridge, (event) => {
    events.push(event);
    if (event.event === "confirm_code") link.answer(true);
  });
  assert.deepEqual(await link.done, { ok: true });
  assert.deepEqual(events.map((e) => e.event), ["qr", "confirm_code", "linked"]);
  assert.deepEqual(events[0].event === "qr" && events[0].modules, ["0000", "0110", "0110", "0000"]);

  const refused = startLink(bridge, (event) => event.event === "confirm_code" && refused.answer(false));
  assert.deepEqual(await refused.done, { ok: false, error: "cancelled" });
});

test("cancelling a link stops the bridge process", posix, async () => {
  const pidFile = `${fakeBridge("")}.pid`;
  const bridge = fakeBridge(`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise(() => setInterval(() => {}, 1000))`);
  const link = startLink(bridge, () => {});
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  link.cancel();
  assert.equal((await link.done).ok, false);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), "the bridge process is still alive");
});

test("ignores malformed link output instead of trusting it", posix, async () => {
  const bridge = fakeBridge(`
    console.log("not json");
    console.log(JSON.stringify({ event: "qr", modules: ["01x"] }));
    console.log(JSON.stringify({ event: "qr", modules: ["01", "1x"] }));
    console.log(JSON.stringify({ event: "linked", message: "ok" }));
    process.exit(0);`);
  const events: LinkEvent[] = [];
  assert.deepEqual(await startLink(bridge, (e) => events.push(e)).done, { ok: true });
  assert.deepEqual(events.map((e) => e.event), ["linked"]);
});
