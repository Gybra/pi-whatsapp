import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setup } from "../extensions/index.ts";
import { createSessionSigner } from "../src/approval.ts";
import { BridgeError } from "../src/bridge-client.ts";
import type { BridgeClient, BridgeRelease, Deps, SessionSigner } from "../src/types.ts";
import { fakeBridge } from "./fake-bridge.ts";
import { textPayload, wireFor } from "./helpers.ts";

const posix = { skip: process.platform === "win32" };
type Handler = (event: unknown, ctx: unknown) => unknown;
// dataDir and purgeAnswer drive "uninstall --purge": purgeAnswer is what the user types at the bridge's own prompt.
type State = { running: boolean; linked: boolean; autostart: boolean; approver: string; dataDir?: string; purgeAnswer?: string; failUninstall?: boolean };

/** A whatsapp-mcp stand-in that keeps its state in a file and logs every command. */
function statefulBridge(initial: Partial<State> = {}) {
  const stateFile = join(mkdtempSync(join(tmpdir(), "pi-whatsapp-state-")), "state.json");
  writeFileSync(stateFile, JSON.stringify({ running: false, linked: false, autostart: false, approver: "", ...initial }));
  const path = fakeBridge(`
    const fs = require("fs");
    const file = ${JSON.stringify(stateFile)};
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    const save = () => fs.writeFileSync(file, JSON.stringify(st));
    fs.appendFileSync(file + ".log", args.join(" ") + "\\n");
    const say = (e) => console.log(JSON.stringify(e));
    switch (args[0]) {
      case "status":
        say({ version: "0.1.0", running: st.running, state: st.running ? (st.linked ? "online" : "unpaired") : "stopped", connected: st.running && st.linked,
          linked: st.linked, approver_id: st.approver, autostart: st.autostart, data_dir: "/data", log_file: "/data/bridge.log" });
        return;
      case "start": st.running = true; save(); return;
      case "stop": st.running = false; save(); return;
      case "autostart": st.autostart = args[1] === "enable"; st.running = st.autostart; save(); return;
      case "link":
        if (st.running) { console.error("Error: the bridge is running; stop it first"); process.exit(1); }
        say({ event: "qr", modules: ["0000", "0110", "0110", "0000"], expires_in: 60 });
        st.linked = true; save();
        say({ event: "linked", message: "This computer is now linked to WhatsApp." });
        process.exit(0);
      case "uninstall":
        if (st.failUninstall) { console.error("Error: the bridge did not stop; see whatsapp-mcp logs"); process.exit(1); }
        st.running = false; st.autostart = false; save();
        if (args[1] === "--purge" && st.purgeAnswer === "yes") fs.rmSync(st.dataDir, { recursive: true, force: true });
        process.exit(0);
      case "pair-pi":
        process.stdin.on("end", () => {
          st.approver = require("crypto").createHash("sha256").update(Buffer.from(input.trim(), "base64")).digest("hex");
          save();
          say({ approver_id: st.approver });
        });
        return;
    }
    console.error("Error: unknown command"); process.exit(2);`);
  return {
    path,
    state: () => JSON.parse(readFileSync(stateFile, "utf8")) as State,
    commands: () => (existsSync(stateFile + ".log") ? readFileSync(stateFile + ".log", "utf8").trim().split("\n") : []),
  };
}

function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const registered: unknown[] = [];
  const unregistered: string[] = [];
  const pi = {
    registerMcpServer(name: string, config: unknown) {
      registered.push({ name, config });
    },
    unregisterMcpServer(name: string) {
      unregistered.push(name);
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => {};
    },
    registerTool() {
      throw new Error("the extension must not register model-callable tools");
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options.handler);
    },
  };
  return {
    pi,
    registered,
    unregistered,
    command: (name: string, args: string, ctx: unknown) => commands.get(name)!(args, ctx),
    emit: (name: string, event: unknown, ctx: unknown = uiCtx().ctx) => handlers.get(name)?.(event, ctx),
  };
}

function uiCtx(answers: { input?: string; confirm?: boolean[]; select?: string[] } = {}, mode = "tui") {
  const notes: string[] = [];
  const asked: string[] = [];
  const confirms = [...(answers.confirm ?? [])];
  const selects = [...(answers.select ?? [])];
  const ctx = {
    mode,
    hasUI: mode !== "print" && mode !== "json",
    cwd: mkdtempSync(join(tmpdir(), "pi-whatsapp-project-")),
    ui: {
      input: async () => answers.input,
      confirm: async (title: string) => (asked.push(title), confirms.shift() ?? false),
      select: async (title: string, options: string[]) => {
        asked.push(title);
        const wanted = selects.shift();
        return options.find((o) => wanted !== undefined && o.startsWith(wanted));
      },
      notify: (message: string) => notes.push(message),
      // The QR screen: run the real component until the link process finishes.
      custom: (factory: (...a: unknown[]) => unknown) =>
        new Promise((resolve) => factory({ terminal: { rows: 60 }, requestRender() {}, stop() {}, start() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve)),
    },
  };
  return { ctx, notes, asked };
}

function deps(options: { client?: Partial<BridgeClient>; release?: BridgeRelease; fetchImpl?: typeof fetch } = {}) {
  const signers: SessionSigner[] = [];
  let revoked = 0;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-whatsapp-agent-"));
  const value: Deps = {
    agentDir,
    dataDir: () => join(agentDir, "bridge-data"),
    release: options.release ?? { version: null, assets: {} },
    platform: process.platform,
    arch: process.arch,
    fetchImpl: options.fetchImpl,
    createSigner: () => {
      const signer = createSessionSigner();
      signers.push(signer);
      return signer;
    },
    connect: (): BridgeClient => ({
      status: async () => ({ state: "online", connected: true, approver_id: signers[0]?.approverID ?? "" }),
      prepare: async () => {
        throw new BridgeError("unreachable");
      },
      cancel: async () => {},
      revoke: async () => {
        revoked++;
      },
      preview: async () => new Uint8Array(),
      ...options.client,
    }),
  };
  return { deps: value, signers, revoked: () => revoked };
}

const outgoing = () => ({ type: "tool_call", toolCallId: "1", toolName: "mcp__whatsapp__send_message", input: { recipient: "12025550123", message: "hi", approval: { draft_id: "x", signature_b64: "y" } } });
const start = { type: "session_start", reason: "startup" };

test("registers no tools and blocks sends until set up", async () => {
  const { pi, emit } = fakePi();
  setup(pi as never, deps().deps);
  const event = outgoing();
  const result = (await emit("tool_call", event)) as { block?: boolean; reason?: string };
  assert.equal(result?.block, true);
  assert.equal("approval" in event.input, false);
  await emit("session_start", start);
  assert.match(((await emit("tool_call", outgoing())) as { reason: string }).reason, /\/whatsapp-setup.*Nothing was sent/);
});

test("/whatsapp-setup links, starts the bridge and registers the MCP server", posix, async () => {
  const bridge = statefulBridge();
  const { pi, registered, command } = fakePi();
  const d = deps();
  setup(pi as never, d.deps);
  const settings = join(d.deps.agentDir, "settings.json");
  writeFileSync(settings, '{"packages":[]}');
  const { ctx, notes } = uiCtx({ confirm: [true, true], select: ["Start automatically"] });
  await command("whatsapp-setup", bridge.path, ctx);
  assert.deepEqual(bridge.state(), { running: true, linked: true, autostart: true, approver: "" });
  assert.deepEqual(registered, [{ name: "whatsapp", config: { command: bridge.path, args: ["mcp"], timeout: 180, exposure: "codemode" } }]);
  assert.deepEqual(JSON.parse(readFileSync(join(d.deps.agentDir, "pi-whatsapp.json"), "utf8")), { bridgePath: bridge.path });
  assert.equal(readFileSync(settings, "utf8"), '{"packages":[]}', "Pi settings are not modified");
  assert.match(notes.join("\n"), /ready/i);
});

test("/whatsapp-setup stops an unlinked bridge before linking and leaves a linked one alone", posix, async () => {
  const unlinked = statefulBridge({ running: true });
  const one = fakePi();
  setup(one.pi as never, deps().deps);
  await one.command("whatsapp-setup", unlinked.path, uiCtx({ confirm: [true, true], select: ["Start it now"] }).ctx);
  assert.deepEqual(unlinked.commands().filter((c) => !c.startsWith("status")), ["stop", "link --json", "start"]);
  assert.equal(unlinked.state().autostart, false);

  const linked = statefulBridge({ running: true, linked: true, autostart: true });
  const two = fakePi();
  setup(two.pi as never, deps().deps);
  const { ctx, asked } = uiCtx({ confirm: [true] });
  await two.command("whatsapp-setup", linked.path, ctx);
  assert.deepEqual(linked.commands().filter((c) => !c.startsWith("status")), [], "nothing to do for a running, linked bridge");
  assert.ok(!asked.some((q) => /Link/.test(q)), "no relinking offered");
});

test("/whatsapp-setup changes nothing when the user declines or the path is unusable", posix, async () => {
  const bridge = statefulBridge();
  for (const [args, answers] of [
    [bridge.path, { confirm: [false] }],
    [bridge.path, { confirm: [true, false] }], // accepts the bridge, declines linking
    ["relative/whatsapp-mcp", { confirm: [true] }],
    ["", { select: ["Use an existing"], input: undefined }],
  ] as const) {
    const { pi, registered, command } = fakePi();
    const d = deps();
    setup(pi as never, d.deps);
    await command("whatsapp-setup", args, uiCtx(answers as never).ctx);
    if ((answers as unknown as { confirm?: boolean[] }).confirm?.[0] !== true) {
      assert.equal(registered.length, 0, JSON.stringify(args));
      assert.equal(existsSync(join(d.deps.agentDir, "pi-whatsapp.json")), false);
    }
  }
  assert.deepEqual(bridge.commands().filter((c) => !c.startsWith("status")), []);
});

test("/whatsapp-setup downloads a verified bridge when a release is available", posix, async () => {
  const bridge = statefulBridge({ linked: true, running: true });
  const binary = readFileSync(bridge.path);
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as "darwin"];
  const cpu = { arm64: "arm64", x64: "amd64" }[process.arch as "arm64"];
  const release: BridgeRelease = { version: "9.9.9", assets: { [`${os}-${cpu}`]: { file: `whatsapp-mcp-${os}-${cpu}`, sha256: createHash("sha256").update(binary).digest("hex") } } };
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => (urls.push(url), new Response(binary))) as unknown as typeof fetch;
  const { pi, registered, command } = fakePi();
  const d = deps({ release, fetchImpl });
  setup(pi as never, d.deps);
  await command("whatsapp-setup", "", uiCtx({ select: ["Download"], confirm: [] }).ctx);
  const installed = join(d.deps.agentDir, "pi-whatsapp-bridge", "9.9.9", "whatsapp-mcp");
  assert.deepEqual(urls, [`https://github.com/Gybra/whatsapp-mcp/releases/download/v9.9.9/whatsapp-mcp-${os}-${cpu}`]);
  assert.deepEqual(registered, [{ name: "whatsapp", config: { command: installed, args: ["mcp"], timeout: 180, exposure: "codemode" } }]);
});

test("a configured bridge is registered at session start unless mcp.json already defines whatsapp", async () => {
  for (const conflict of [false, true]) {
    const { pi, registered, emit } = fakePi();
    const d = deps();
    writeFileSync(join(d.deps.agentDir, "pi-whatsapp.json"), JSON.stringify({ bridgePath: process.execPath }));
    const mcpFile = join(d.deps.agentDir, "mcp.json");
    const mcpContent = JSON.stringify({ mcpServers: { whatsapp: { command: "/usr/bin/uv", args: ["run", "main.py"] } } });
    if (conflict) writeFileSync(mcpFile, mcpContent);
    setup(pi as never, d.deps);
    const { ctx, notes } = uiCtx();
    await emit("session_start", start, ctx);
    assert.equal(registered.length, conflict ? 0 : 1);
    if (conflict) {
      assert.match(notes.join("\n"), /already defines a "whatsapp" server/);
      assert.equal(readFileSync(mcpFile, "utf8"), mcpContent);
    }
  }
});

test("/whatsapp-pair trusts this session's key after confirmation", posix, async () => {
  const bridge = statefulBridge({ running: true, linked: true });
  const { pi, emit, command } = fakePi();
  const d = deps();
  writeFileSync(join(d.deps.agentDir, "pi-whatsapp.json"), JSON.stringify({ bridgePath: bridge.path }));
  setup(pi as never, d.deps);
  await emit("session_start", start);
  await command("whatsapp-pair", "", uiCtx({ confirm: [false] }).ctx);
  assert.equal(bridge.state().approver, "", "declined");
  const { ctx, notes } = uiCtx({ confirm: [true] });
  await command("whatsapp-pair", "", ctx);
  assert.equal(bridge.state().approver, d.signers[0].approverID);
  assert.match(notes.join("\n"), /can now approve/);
});

test("the first send asks once to pair the session, then reviews the message", posix, async () => {
  const bridge = statefulBridge({ running: true, linked: true });
  let signer: SessionSigner | undefined;
  const d = deps({
    client: {
      prepare: async () => {
        if (bridge.state().approver !== signer!.approverID) throw new BridgeError("not_paired");
        return wireFor(textPayload({ expires_at: Math.floor(Date.now() / 1000) + 120 }), signer!.publicKeyB64);
      },
    },
  });
  writeFileSync(join(d.deps.agentDir, "pi-whatsapp.json"), JSON.stringify({ bridgePath: bridge.path }));
  const { pi, emit } = fakePi();
  setup(pi as never, d.deps);
  await emit("session_start", start);
  signer = d.signers[0];
  const { ctx, asked } = uiCtx({ confirm: [true] });
  (ctx.ui as Record<string, unknown>).custom = async () => false; // the user cancels the review
  const result = (await emit("tool_call", outgoing(), ctx)) as { block?: boolean; reason?: string };
  assert.ok(asked.some((q) => /approve WhatsApp messages/.test(q)), "pairing consent asked");
  assert.equal(bridge.state().approver, signer.approverID);
  assert.match(result.reason ?? "", /declined/, "the message itself still went through review");
});

test("keeps the session key across new sessions and revokes it on quit or reload", async () => {
  for (const reason of ["quit", "reload"]) {
    const { pi, emit } = fakePi();
    const fake = deps();
    setup(pi as never, fake.deps);
    await emit("session_start", start);
    await emit("session_shutdown", { type: "session_shutdown", reason: "new" });
    await emit("session_start", { type: "session_start", reason: "new" });
    assert.equal(fake.signers.length, 1, "a new session in the same Pi process keeps the pairing");
    assert.equal(fake.revoked(), 0);
    await emit("session_shutdown", { type: "session_shutdown", reason });
    assert.equal(fake.revoked(), 1, reason);
    assert.throws(() => fake.signers[0].sign(new Uint8Array(1)), /disposed/, `${reason} destroys the key`);
  }
});

test("does not revoke an approver paired by another Pi session", async () => {
  const { pi, emit } = fakePi();
  const fake = deps({ client: { status: async () => ({ state: "online", connected: true, approver_id: "0".repeat(64) }) } });
  setup(pi as never, fake.deps);
  await emit("session_start", start);
  await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(fake.revoked(), 0);
});

test("blocks the model from the bridge's credentials, even before a session starts", async () => {
  const { pi, emit } = fakePi();
  const d = deps();
  setup(pi as never, d.deps);
  const read = { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: join(d.deps.dataDir(), "api-token") } };
  assert.equal(((await emit("tool_call", read)) as { block?: boolean })?.block, true);
  const pair = { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "echo KEY | whatsapp-mcp pair-pi" } };
  assert.equal(((await emit("tool_call", pair)) as { block?: boolean })?.block, true);
  assert.equal(await emit("tool_call", { type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: "ls" } }), undefined);
});

test("commands refuse outside the interactive TUI", async () => {
  const { pi, command, emit } = fakePi();
  setup(pi as never, deps().deps);
  await emit("session_start", start);
  for (const name of ["whatsapp-pair", "whatsapp-setup", "whatsapp-uninstall"]) {
    const { ctx, notes } = uiCtx({}, "rpc");
    await command(name, "", ctx);
    assert.match(notes.join("\n"), /interactive/, name);
  }
});

test("/whatsapp-status reports the bridge and this session's pairing", posix, async () => {
  const bridge = statefulBridge({ running: true, linked: true, autostart: true });
  const { pi, command, emit } = fakePi();
  const d = deps();
  writeFileSync(join(d.deps.agentDir, "pi-whatsapp.json"), JSON.stringify({ bridgePath: bridge.path }));
  setup(pi as never, d.deps);
  await emit("session_start", start);
  const { ctx, notes } = uiCtx();
  await command("whatsapp-status", "", ctx);
  assert.match(notes.join("\n"), /online.*linked.*autostart on.*not paired/s);
});

/** A Pi set up with the given bridge: config and some local data written, session started. */
async function setUpWith(bridgePath: string, d = deps()) {
  const fake = fakePi();
  writeFileSync(join(d.deps.agentDir, "pi-whatsapp.json"), JSON.stringify({ bridgePath }));
  mkdirSync(d.deps.dataDir());
  writeFileSync(join(d.deps.dataDir(), "whatsapp.db"), "session");
  setup(fake.pi as never, d.deps);
  await fake.emit("session_start", start);
  return { ...fake, d, configFile: join(d.deps.agentDir, "pi-whatsapp.json"), installDir: join(d.deps.agentDir, "pi-whatsapp-bridge") };
}

/** Copies a stand-in bridge to where /whatsapp-setup downloads it. */
function downloadedBridge(agentDir: string, path: string): string {
  const dir = join(agentDir, "pi-whatsapp-bridge", "0.1.0");
  mkdirSync(dir, { recursive: true });
  copyFileSync(path, join(dir, "whatsapp-mcp"));
  chmodSync(join(dir, "whatsapp-mcp"), 0o755);
  return join(dir, "whatsapp-mcp");
}

const bridgeCalls = (bridge: { commands(): string[] }) => bridge.commands().filter((c) => !c.startsWith("status"));

test("/whatsapp-uninstall keeps data by default, removes the download and the tools, and is safe to rerun", posix, async () => {
  const d = deps();
  const bridge = statefulBridge({ running: true, linked: true, autostart: true, dataDir: d.deps.dataDir() });
  const pi = await setUpWith(downloadedBridge(d.deps.agentDir, bridge.path), d);
  const { ctx, notes, asked } = uiCtx({ confirm: [true], select: ["Keep local data"] });
  await pi.command("whatsapp-uninstall", "", ctx);
  assert.deepEqual(bridgeCalls(bridge), ["uninstall"]);
  assert.equal(bridge.state().running || bridge.state().autostart, false);
  assert.ok(asked.some((q) => /WhatsApp data/.test(q)), "keep or purge asked");
  assert.equal(existsSync(pi.configFile), false);
  assert.equal(existsSync(pi.installDir), false, "the downloaded bridge is removed");
  assert.equal(existsSync(join(d.deps.dataDir(), "whatsapp.db")), true, "local data is kept");
  assert.deepEqual(pi.unregistered, ["whatsapp"]);
  assert.match(((await pi.emit("tool_call", outgoing())) as { reason: string }).reason, /Nothing was sent/);
  const report = notes.join("\n");
  assert.match(report, /remain in .*bridge-data/);
  assert.match(report, /Linked devices/);
  assert.match(report, /pi uninstall npm:pi-whatsapp/);

  const again = uiCtx();
  await pi.command("whatsapp-uninstall", "", again.ctx);
  assert.match(again.notes.join("\n"), /nothing to remove/);
  assert.deepEqual(bridgeCalls(bridge), ["uninstall"], "a rerun runs nothing");
});

test("/whatsapp-uninstall changes nothing when cancelled at any step", posix, async () => {
  for (const answers of [{ confirm: [false] }, { confirm: [true], select: [] }, { confirm: [true], select: ["Purge", "Cancel"] }]) {
    const d = deps();
    const bridge = statefulBridge({ running: true, linked: true, autostart: true, dataDir: d.deps.dataDir() });
    const pi = await setUpWith(downloadedBridge(d.deps.agentDir, bridge.path), d);
    const { ctx, notes } = uiCtx(answers);
    await pi.command("whatsapp-uninstall", "", ctx);
    assert.deepEqual(bridgeCalls(bridge), [], JSON.stringify(answers));
    assert.equal(existsSync(pi.configFile) && existsSync(pi.installDir), true);
    assert.deepEqual(pi.unregistered, []);
    assert.match(notes.join("\n"), /cancelled. Nothing was changed/);
  }
});

test("/whatsapp-uninstall purges through the bridge and never deletes a user's bridge or mcp.json", posix, async () => {
  for (const purgeAnswer of ["yes", "no"]) {
    const d = deps();
    const bridge = statefulBridge({ running: true, linked: true, dataDir: d.deps.dataDir(), purgeAnswer });
    const mcpFile = join(d.deps.agentDir, "mcp.json");
    const mcpContent = JSON.stringify({ mcpServers: { whatsapp: { command: bridge.path, args: ["mcp"] } } });
    writeFileSync(mcpFile, mcpContent);
    const pi = await setUpWith(bridge.path, d);
    const { ctx, notes, asked } = uiCtx({ confirm: [true], select: ["Purge", "Delete"] });
    await pi.command("whatsapp-uninstall", "", ctx);
    assert.ok(asked.some((q) => q.startsWith(`Permanently delete ${d.deps.dataDir()}?`)), "purge confirmed separately");
    assert.deepEqual(bridgeCalls(bridge), ["uninstall --purge"]);
    assert.equal(existsSync(d.deps.dataDir()), purgeAnswer !== "yes", purgeAnswer);
    assert.equal(existsSync(bridge.path), true, "an external bridge is never deleted");
    assert.equal(existsSync(pi.configFile), false);
    assert.equal(readFileSync(mcpFile, "utf8"), mcpContent);
    const report = notes.join("\n");
    assert.match(report, purgeAnswer === "yes" ? /data was deleted/ : /remain in/);
    assert.match(report, /mcp.json still defines a "whatsapp" server/);
  }
});

test("/whatsapp-uninstall without a usable bridge removes Pi's files and says what is left", posix, async () => {
  const pi = await setUpWith("/nonexistent/whatsapp-mcp");
  const { ctx, notes, asked } = uiCtx({ confirm: [true] });
  await pi.command("whatsapp-uninstall", "", ctx);
  assert.ok(!asked.some((q) => /WhatsApp data/.test(q)), "no purge without a bridge to run it");
  assert.equal(existsSync(pi.configFile), false);
  assert.equal(existsSync(join(pi.d.deps.dataDir(), "whatsapp.db")), true);
  assert.match(notes.join("\n"), /could not be stopped from Pi.*not found.*whatsapp-mcp uninstall/s);

  // An interrupted setup: the bridge was downloaded but never configured.
  const d = deps();
  downloadedBridge(d.deps.agentDir, statefulBridge().path);
  const { pi: interrupted, command } = fakePi();
  setup(interrupted as never, d.deps);
  await command("whatsapp-uninstall", "", uiCtx({ confirm: [true] }).ctx);
  assert.equal(existsSync(join(d.deps.agentDir, "pi-whatsapp-bridge")), false);
});

test("/whatsapp-uninstall keeps everything when the bridge fails, so it can be run again", posix, async () => {
  const d = deps();
  const bridge = statefulBridge({ running: true, linked: true, autostart: true, failUninstall: true });
  const pi = await setUpWith(downloadedBridge(d.deps.agentDir, bridge.path), d);
  const { ctx, notes } = uiCtx({ confirm: [true], select: ["Keep"] });
  await pi.command("whatsapp-uninstall", "", ctx);
  assert.equal(existsSync(pi.configFile) && existsSync(pi.installDir), true);
  assert.deepEqual(pi.unregistered, []);
  assert.match(notes.join("\n"), /could not be uninstalled: the bridge did not stop.*Nothing else was changed/s);
});
