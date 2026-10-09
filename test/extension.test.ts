import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "../extensions/index.ts";
import { createSessionSigner } from "../src/approval.ts";
import type { BridgeClient } from "../src/bridge-client.ts";
import type { SessionSigner } from "../src/protocol.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => {};
    },
    registerTool() {
      throw new Error("the extension must not register model-callable tools");
    },
    registerCommand() {},
  };
  return { pi, emit: (name: string, event: unknown, ctx: unknown = { mode: "tui", hasUI: true }) => handlers.get(name)?.(event, ctx) };
}

function fakeDeps(options: { connectError?: boolean; approverMatches?: boolean } = {}) {
  const signers: SessionSigner[] = [];
  let revoked = 0;
  const deps = {
    createSigner: () => {
      const signer = createSessionSigner();
      signers.push(signer);
      return signer;
    },
    connect: (): BridgeClient => {
      if (options.connectError) throw new Error("no token");
      return {
        status: async () => ({ state: "online", connected: true, approver_id: options.approverMatches === false ? "0".repeat(64) : signers[0].approverID, approver_expires_at: 0 }),
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
