import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setup } from "../extensions/index.ts";
import { createSessionSigner } from "../src/approval.ts";
import type { BridgeClient } from "../src/bridge-client.ts";
import type { SessionSigner } from "../src/protocol.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const registered: unknown[] = [];
  const pi = {
    registerMcpServer(name: string, config: unknown) {
      registered.push({ name, config });
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
    command: (name: string, args: string, ctx: unknown) => commands.get(name)!(args, ctx),
    emit: (name: string, event: unknown, ctx: unknown = { mode: "tui", hasUI: true, cwd: tmpdir(), ui: { notify() {} } }) => handlers.get(name)?.(event, ctx),
  };
}

function fakeDeps(options: { connectError?: boolean; approverMatches?: boolean } = {}) {
  const signers: SessionSigner[] = [];
  let revoked = 0;
  const deps = {
    agentDir: mkdtempSync(join(tmpdir(), "pi-whatsapp-agent-")),
    createSigner: () => {
      const signer = createSessionSigner();
      signers.push(signer);
      return signer;
    },
    connect: (): BridgeClient => {
      if (options.connectError) throw new Error("no token");
      return {
        status: async () => ({ state: "online", connected: true, approver_id: options.approverMatches === false ? "0".repeat(64) : signers[0].approverID}),
        prepare: async () => {
          throw new Error("not used");
        },
        cancel: async () => {},
        revoke: async () => {
          revoked++;
        },
        preview: async () => new Uint8Array(),
      };
    },
  };
  return { deps, signers, revoked: () => revoked };
}

const outgoing = () => ({ type: "tool_call", toolCallId: "1", toolName: "mcp__whatsapp__send_message", input: { recipient: "12025550123", message: "hi", approval: { draft_id: "x", signature_b64: "y" } } });

test("registers no tools and blocks sends until a session has started", async () => {
  const { pi, emit } = fakePi();
  setup(pi as never, fakeDeps().deps);
  const event = outgoing();
  const result = (await emit("tool_call", event)) as { block?: boolean };
  assert.equal(result?.block, true);
  assert.equal("approval" in event.input, false);
});

test("blocks sends with a clear reason when the bridge is not set up", async () => {
  const { pi, emit } = fakePi();
  setup(pi as never, fakeDeps({ connectError: true }).deps);
  await emit("session_start", { type: "session_start", reason: "startup" });
  const event = outgoing();
  const result = (await emit("tool_call", event)) as { block?: boolean; reason?: string };
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /not set up.*nothing was sent/i);
  assert.equal("approval" in event.input, false);
});

test("keeps the session key across new sessions and revokes it on quit or reload", async () => {
  for (const reason of ["quit", "reload"]) {
    const { pi, emit } = fakePi();
    const fake = fakeDeps();
    setup(pi as never, fake.deps);
    await emit("session_start", { type: "session_start", reason: "startup" });
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
  const fake = fakeDeps({ approverMatches: false });
  setup(pi as never, fake.deps);
  await emit("session_start", { type: "session_start", reason: "startup" });
  await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(fake.revoked(), 0);
});

test("leaves non-WhatsApp tools alone", async () => {
  const { pi, emit } = fakePi();
  setup(pi as never, fakeDeps().deps);
  await emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(await emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls" } }), undefined);
});

function commandCtx(answers: { input?: string; confirm?: boolean }, cwd = mkdtempSync(join(tmpdir(), "pi-whatsapp-project-"))) {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      mode: "tui",
      hasUI: true,
      cwd,
      ui: { input: async () => answers.input, confirm: async () => answers.confirm ?? false, notify: (message: string) => notes.push(message) },
    },
  };
}

test("/whatsapp-setup saves the bridge path and registers a session-only MCP server", async () => {
  const { pi, registered, command, emit } = fakePi();
  const fake = fakeDeps();
  setup(pi as never, fake.deps);
  const settings = join(fake.deps.agentDir, "settings.json");
  writeFileSync(settings, '{"packages":[]}');
  const bridge = process.execPath; // any absolute executable stands in for the bridge
  const { ctx, notes } = commandCtx({ input: bridge, confirm: true });
  await command("whatsapp-setup", "", ctx);
  assert.deepEqual(registered, [{ name: "whatsapp", config: { command: bridge, args: ["mcp"], timeout: 180, exposure: "codemode" } }]);
  assert.deepEqual(JSON.parse(readFileSync(join(fake.deps.agentDir, "pi-whatsapp.json"), "utf8")), { bridgePath: bridge });
  assert.equal(readFileSync(settings, "utf8"), '{"packages":[]}', "Pi settings are not modified");
  assert.match(notes.join("\n"), /\/whatsapp-pair/);

  await emit("session_start", { type: "session_start", reason: "new" }, ctx);
  assert.equal(registered.length, 1, "registration is not repeated");
});

test("/whatsapp-setup changes nothing without confirmation or a valid executable", async () => {
  for (const answers of [{ input: process.execPath, confirm: false }, { input: "relative/whatsapp-mcp", confirm: true }, { input: undefined }]) {
    const { pi, registered, command } = fakePi();
    const fake = fakeDeps();
    setup(pi as never, fake.deps);
    await command("whatsapp-setup", "", commandCtx(answers).ctx);
    assert.equal(registered.length, 0, JSON.stringify(answers));
    assert.throws(() => readFileSync(join(fake.deps.agentDir, "pi-whatsapp.json")));
  }
});

test("a configured bridge is registered at session start unless mcp.json already defines whatsapp", async () => {
  for (const conflict of [false, true]) {
    const { pi, registered, emit } = fakePi();
    const fake = fakeDeps();
    writeFileSync(join(fake.deps.agentDir, "pi-whatsapp.json"), JSON.stringify({ bridgePath: process.execPath }));
    const mcpFile = join(fake.deps.agentDir, "mcp.json");
    const mcpContent = JSON.stringify({ mcpServers: { whatsapp: { command: "/usr/bin/uv", args: ["run", "main.py"] } } });
    if (conflict) writeFileSync(mcpFile, mcpContent);
    setup(pi as never, fake.deps);
    const { ctx, notes } = commandCtx({});
    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.equal(registered.length, conflict ? 0 : 1);
    if (conflict) {
      assert.match(notes.join("\n"), /already defines a "whatsapp" server/);
      assert.equal(readFileSync(mcpFile, "utf8"), mcpContent);
    }
  }
});

test("pairing and status commands refuse outside the interactive TUI", async () => {
  const { pi, command, emit } = fakePi();
  setup(pi as never, fakeDeps().deps);
  await emit("session_start", { type: "session_start", reason: "startup" });
  for (const name of ["whatsapp-pair", "whatsapp-setup"]) {
    const notes: string[] = [];
    await command(name, "", { mode: "rpc", hasUI: true, cwd: tmpdir(), ui: { notify: (m: string) => notes.push(m), input: () => assert.fail(), confirm: () => assert.fail(), custom: () => assert.fail() } });
    assert.match(notes.join("\n"), /interactive/, name);
  }
});

test("reminds the user to pair when the bridge is configured but this session is not paired", async () => {
  for (const [configured, matches, expected] of [[true, false, true], [true, true, false], [false, false, false]] as const) {
    const { pi, emit } = fakePi();
    const fake = fakeDeps({ approverMatches: matches });
    if (configured) writeFileSync(join(fake.deps.agentDir, "pi-whatsapp.json"), JSON.stringify({ bridgePath: process.execPath }));
    setup(pi as never, fake.deps);
    const { ctx, notes } = commandCtx({});
    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.equal(notes.some((note) => /\/whatsapp-pair/.test(note)), expected, `configured ${configured}, paired ${matches}`);
  }
});

test("the startup reminder never blocks on an unreachable bridge", async () => {
  const { pi, emit } = fakePi();
  const fake = fakeDeps();
  fake.deps.connect = () => ({ status: () => new Promise(() => {}) }) as never; // hangs forever
  writeFileSync(join(fake.deps.agentDir, "pi-whatsapp.json"), JSON.stringify({ bridgePath: process.execPath }));
  setup(pi as never, fake.deps);
  const started = Date.now();
  await emit("session_start", { type: "session_start", reason: "startup" }, commandCtx({}).ctx);
  assert.ok(Date.now() - started < 3000, "session start waited too long for the bridge");
});
