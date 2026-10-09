import assert from "node:assert/strict";
import test from "node:test";
import { createSessionSigner } from "../src/approval.ts";
import { BridgeError, type BridgeClient, type RuntimeStatus } from "../src/bridge-client.ts";
import { pairingInstructions, runPairing, waitForPairing } from "../src/pairing.ts";
import { keyFromSeed, RFC_TEST_SEED } from "./helpers.ts";

function statusClient(statuses: (RuntimeStatus | Error)[]): BridgeClient & { calls: number } {
  const client = {
    calls: 0,
    async status() {
      const next = statuses[Math.min(client.calls++, statuses.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return client as never;
}

const unpaired: RuntimeStatus = { state: "online", connected: true, approver_id: ""};

test("instructions show the public key, fingerprint and command, never the private key", () => {
  const signer = createSessionSigner(keyFromSeed(RFC_TEST_SEED));
  const text = pairingInstructions(signer, "/opt/whatsapp mcp/whatsapp-mcp").join("\n");
  assert.ok(text.includes(signer.publicKeyB64));
  assert.ok(text.includes(signer.approverID));
  assert.ok(text.includes("'/opt/whatsapp mcp/whatsapp-mcp' setup --pair-pi"));
  assert.ok(!text.includes(RFC_TEST_SEED) && !text.includes(Buffer.from(RFC_TEST_SEED, "hex").toString("base64")));
  assert.ok(pairingInstructions(signer, undefined).join("\n").includes("whatsapp-mcp setup --pair-pi"));
  assert.match(text, /until Pi quits or reloads/);
  assert.doesNotMatch(text, /hours/);
});

test("waits until the bridge trusts exactly this session's key", async () => {
  const signer = createSessionSigner();
  const other = { ...unpaired, approver_id: "0".repeat(64)};
  const mine = { ...unpaired, approver_id: signer.approverID};
  const client = statusClient([unpaired, new BridgeError("unreachable"), other, mine]);
  assert.equal(await waitForPairing(client, signer.approverID, AbortSignal.timeout(5000), 1), true);
  assert.equal(client.calls, 4);
});

test("stops waiting when aborted, for example against an unrelated service", async () => {
  const client = statusClient([new BridgeError("bad_response")]);
  assert.equal(await waitForPairing(client, "a".repeat(64), AbortSignal.timeout(50), 5), false);
});

test("the pairing screen needs an interactive TUI and closes on Escape or success", async () => {
  const signer = createSessionSigner();
  const never = statusClient([unpaired]);
  const rpc = { mode: "rpc", hasUI: true, ui: { custom: () => assert.fail("no dialog outside the TUI") } };
  assert.equal(await runPairing(rpc as never, never, signer, undefined), false);

  let view: { handleInput(data: string): void; render(width: number): string[]; dispose?(): void } | undefined;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: (factory: (...args: unknown[]) => typeof view) =>
        new Promise((resolve) => {
          view = factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve);
        }),
    },
  };
  const escaped = runPairing(ctx as never, never, signer, "/opt/bin/whatsapp-mcp");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(view!.render(60).join("\n").includes(signer.approverID.slice(0, 16)));
  view!.handleInput("\x1b");
  const quickly = new Promise((resolve) => setTimeout(() => resolve("still open"), 1000).unref());
  assert.equal(await Promise.race([escaped, quickly]), false, "Escape closes the pairing screen at once");
  view!.dispose?.();

  const paired = runPairing(ctx as never, statusClient([{ ...unpaired, approver_id: signer.approverID}]), signer, undefined, 1);
  assert.equal(await paired, true);
});
