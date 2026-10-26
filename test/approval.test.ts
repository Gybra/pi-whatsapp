import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import test from "node:test";
import { createApprovalController, createSessionSigner, isOutgoingWhatsAppCall, toSendInput } from "../src/approval.ts";
import { BridgeError } from "../src/bridge-client.ts";
import type { ReviewedDraft, SendInput, SessionSigner } from "../src/types/approval.ts";
import type { BridgeClient } from "../src/types/bridge.ts";
import { wireFor } from "./helpers.ts";

const NOW = 1_800_000_000;

function fakeClient(signer: SessionSigner, overrides: Partial<BridgeClient> = {}) {
  const calls = { prepare: [] as SendInput[], cancel: [] as string[], preview: [] as string[] };
  let counter = 0;
  const client: BridgeClient = {
    async status() {
      return { state: "online", connected: true, approver_id: signer.approverID};
    },
    async prepare(input) {
      calls.prepare.push(input);
      const draft_id = (++counter).toString(16).padStart(32, "0");
      const attachment = input.kind === "text" ? null : { id: input.media_id, name: input.media_id, mime: "application/pdf", size: 3, sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" };
      const payload = { version: 1, draft_id, recipient_jid: `${input.recipient}@s.whatsapp.net`, message: input.message, kind: input.kind, attachment, expires_at: NOW + 120 };
      return wireFor(payload, signer.publicKeyB64);
    },
    async cancel(id) {
      calls.cancel.push(id);
    },
    async revoke() {},
    async preview(id) {
      calls.preview.push(id);
      return Uint8Array.from([1, 2, 3]);
    },
    ...overrides,
  };
  return { client, calls };
}

type Review = (ctx: unknown, draft: ReviewedDraft, signal: AbortSignal, preview?: Uint8Array) => Promise<boolean>;

function setup(options: { review?: Review; client?: Partial<BridgeClient>; now?: () => number; ensurePaired?: () => Promise<boolean> } = {}) {
  const signer = createSessionSigner();
  const { client, calls } = fakeClient(signer, options.client);
  const reviews: { draft: ReviewedDraft; signal: AbortSignal; preview?: Uint8Array }[] = [];
  const review: Review = async (ctx, draft, signal, preview) => {
    reviews.push({ draft, signal, preview });
    return options.review ? options.review(ctx, draft, signal, preview) : true;
  };
  const controller = createApprovalController(client, signer, review as never, options.now ?? (() => NOW), options.ensurePaired);
  return { signer, controller, calls, reviews };
}

const tuiCtx = (signal?: AbortSignal) => ({ mode: "tui", hasUI: true, signal }) as never;

function sendEvent(input: Record<string, unknown>, toolName = "mcp__whatsapp__send_message", parentToolCallId?: string) {
  return { type: "tool_call", toolCallId: "call-1", parentToolCallId, toolName, input } as never as { input: Record<string, unknown>; toolName: string };
}

function verifyProof(signer: SessionSigner, draft: ReviewedDraft, signatureB64: string): boolean {
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(signer.publicKeyB64, "base64").toString("base64url") }, format: "jwk" });
  return verify(null, draft.challengeBytes, key, Buffer.from(signatureB64, "base64"));
}

test("maps exactly the three outgoing tools to send inputs", () => {
  assert.equal(isOutgoingWhatsAppCall({ toolName: "mcp__whatsapp__list_chats" }), false);
  assert.deepEqual(toSendInput("mcp__whatsapp__send_message", { recipient: "1", message: "hi" }), { kind: "text", recipient: "1", message: "hi", media_id: "" });
  assert.deepEqual(toSendInput("mcp__whatsapp__send_file", { recipient: "1", media_id: "a.pdf" }), { kind: "file", recipient: "1", message: "", media_id: "a.pdf" });
  assert.deepEqual(toSendInput("mcp__whatsapp__send_audio_message", { recipient: "1", media_id: "v.ogg", approval: {} }), { kind: "voice", recipient: "1", message: "", media_id: "v.ogg" });
  for (const bad of [{ recipient: "1", media_path: "/etc/passwd" }, { recipient: "1" }, { recipient: 1, media_id: "a" }, { recipient: "1", media_id: "a", caption: "x" }]) {
    assert.equal(toSendInput("mcp__whatsapp__send_file", bad), undefined, JSON.stringify(bad));
  }
});

test("leaves read tools untouched", async () => {
  const { controller, calls } = setup();
  const event = sendEvent({ limit: 5 }, "mcp__whatsapp__list_chats");
  assert.equal(await controller.handle(event as never, tuiCtx()), undefined);
  assert.deepEqual(event.input, { limit: 5 });
  assert.equal(calls.prepare.length, 0);
});

test("adds a proof for the reviewed draft only after approval", async () => {
  for (const [toolName, input] of [
    ["mcp__whatsapp__send_message", { recipient: "12025550123", message: "hi" }],
    ["mcp__whatsapp__send_file", { recipient: "12025550123", media_id: "a.pdf" }],
    ["mcp__whatsapp__send_audio_message", { recipient: "12025550123", media_id: "v.ogg" }],
  ] as const) {
    const { signer, controller, reviews } = setup();
    const event = sendEvent({ ...input, approval: { draft_id: "f".repeat(32), signature_b64: "forged" } }, toolName, "codemode-1");
    assert.equal(await controller.handle(event as never, tuiCtx()), undefined, toolName);
    const proof = event.input.approval as { draft_id: string; signature_b64: string };
    assert.equal(proof.draft_id, reviews[0].draft.payload.draft_id, "the model-supplied proof is replaced");
    assert.ok(verifyProof(signer, reviews[0].draft, proof.signature_b64));
    assert.deepEqual({ ...event.input, approval: undefined }, { ...input, approval: undefined }, "reviewed arguments are not rewritten");
    if (toolName !== "mcp__whatsapp__send_message") assert.deepEqual(reviews[0].preview, Uint8Array.from([1, 2, 3]));
  }
});

test("blocks and cancels the draft when the user declines", async () => {
  const { controller, calls } = setup({ review: async () => false });
  const event = sendEvent({ recipient: "12025550123", message: "hi" });
  const result = await controller.handle(event as never, tuiCtx());
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /declined.*not sent/i);
  assert.equal(event.input.approval, undefined);
  assert.equal(calls.cancel.length, 1);
});

test("blocks without an interactive TUI, before contacting the bridge", async () => {
  for (const ctx of [{ mode: "rpc", hasUI: true }, { mode: "print", hasUI: false }, { mode: "json", hasUI: false }]) {
    const { controller, calls } = setup();
    const event = sendEvent({ recipient: "12025550123", message: "hi", approval: { draft_id: "x", signature_b64: "y" } });
    assert.equal((await controller.handle(event as never, ctx as never))?.block, true, ctx.mode);
    assert.equal(event.input.approval, undefined, "a model-supplied proof never survives");
    assert.equal(calls.prepare.length, 0);
  }
});

test("blocks unsupported arguments such as a raw media path", async () => {
  const { controller, calls } = setup();
  const result = await controller.handle(sendEvent({ recipient: "12025550123", media_path: "/Users/ada/.ssh/id_ed25519" }, "mcp__whatsapp__send_file") as never, tuiCtx());
  assert.equal(result?.block, true);
  assert.equal(calls.prepare.length, 0);
});

test("one approval at a time: a parallel send is blocked, not queued or shared", async () => {
  let release: (approved: boolean) => void = () => {};
  const { controller, calls } = setup({ review: () => new Promise((resolve) => (release = resolve)) });
  const first = controller.handle(sendEvent({ recipient: "12025550123", message: "one" }) as never, tuiCtx());
  await new Promise((resolve) => setImmediate(resolve));
  const second = sendEvent({ recipient: "12025550123", message: "two" });
  const secondResult = await controller.handle(second as never, tuiCtx());
  assert.equal(secondResult?.block, true);
  assert.match(secondResult?.reason ?? "", /one message at a time/i);
  assert.equal(second.input.approval, undefined);
  release(true);
  assert.equal(await first, undefined);
  assert.equal(calls.prepare.length, 1);
});

test("an abort during review blocks the send and cancels the draft", async () => {
  const turn = new AbortController();
  const { controller, calls } = setup({
    review: (_ctx, _draft, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(false));
        turn.abort();
      }),
  });
  const event = sendEvent({ recipient: "12025550123", message: "hi" });
  assert.equal((await controller.handle(event as never, tuiCtx(turn.signal)))?.block, true);
  assert.equal(event.input.approval, undefined);
  assert.equal(calls.cancel.length, 1);
});

test("an abort right after approval still blocks the send", async () => {
  const turn = new AbortController();
  const { controller } = setup({
    review: async () => {
      turn.abort();
      return true;
    },
  });
  const event = sendEvent({ recipient: "12025550123", message: "hi" });
  assert.equal((await controller.handle(event as never, tuiCtx(turn.signal)))?.block, true);
  assert.equal(event.input.approval, undefined);
});

test("cancelAll closes an open review", async () => {
  const { controller } = setup({ review: (_ctx, _draft, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(false))) });
  const pending = controller.handle(sendEvent({ recipient: "12025550123", message: "hi" }) as never, tuiCtx());
  await new Promise((resolve) => setImmediate(resolve));
  await controller.cancelAll();
  assert.equal((await pending)?.block, true);
});

test("an approval that expires during review is not signed", async () => {
  let now = NOW;
  const { controller } = setup({
    now: () => now,
    review: async () => {
      now = NOW + 120;
      return true;
    },
  });
  const event = sendEvent({ recipient: "12025550123", message: "hi" });
  const result = await controller.handle(event as never, tuiCtx());
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /expired/i);
  assert.equal(event.input.approval, undefined);
});

test("explains bridge failures without retrying", async () => {
  for (const [code, pattern] of [
    ["not_paired", /\/whatsapp-pair/],
    ["unreachable", /not reachable/],
    ["invalid_request", /rejected/],
    ["media_not_found", /outbox/],
    ["unsupported_media", /file type/],
    ["secret_rejected", /credential/],
  ] as const) {
    let attempts = 0;
    const { controller, reviews } = setup({
      client: {
        async prepare() {
          attempts++;
          throw new BridgeError(code);
        },
      },
    });
    const result = await controller.handle(sendEvent({ recipient: "12025550123", message: "hi" }) as never, tuiCtx());
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", pattern);
    assert.match(result?.reason ?? "", /nothing was sent/i);
    assert.equal(attempts, 1);
    assert.equal(reviews.length, 0);
  }
});

test("rejects a draft that is not bound to this session's key", async () => {
  const other = createSessionSigner();
  const { controller, reviews } = setup({
    client: { prepare: async (input) => wireFor({ version: 1, draft_id: "1".repeat(32), recipient_jid: "x@s.whatsapp.net", message: input.message, kind: "text", attachment: null, expires_at: NOW + 120 }, other.publicKeyB64) },
  });
  assert.equal((await controller.handle(sendEvent({ recipient: "12025550123", message: "hi" }) as never, tuiCtx()))?.block, true);
  assert.equal(reviews.length, 0);
});

test("pairs the session once, with the user's consent, when the bridge does not trust it yet", async () => {
  let paired = false;
  let asked = 0;
  let sessionSigner: SessionSigner | undefined;
  const h = setup({
    ensurePaired: async () => {
      asked++;
      paired = true;
      return true;
    },
    client: {
      async prepare(input, signal) {
        if (!paired) throw new BridgeError("not_paired");
        return fakeClient(sessionSigner!).client.prepare(input, signal);
      },
    },
  });
  sessionSigner = h.signer;
  const event = sendEvent({ recipient: "12025550123", message: "hi" });
  assert.equal(await h.controller.handle(event as never, tuiCtx()), undefined);
  assert.equal(asked, 1);
  assert.equal(h.reviews.length, 1, "after pairing, the message is still reviewed");
  assert.ok(event.input.approval, "approved after review");
  await h.controller.handle(sendEvent({ recipient: "12025550123", message: "again" }) as never, tuiCtx());
  assert.equal(asked, 1, "pairing is asked once, not for every message");
});

test("only a not_paired refusal asks to pair", async () => {
  let asked = 0;
  const { controller } = setup({
    ensurePaired: async () => (asked++, true),
    client: {
      async prepare() {
        throw new BridgeError("unreachable");
      },
    },
  });
  assert.equal((await controller.handle(sendEvent({ recipient: "12025550123", message: "hi" }) as never, tuiCtx()))?.block, true);
  assert.equal(asked, 0);
});

test("a declined pairing blocks the send without retrying", async () => {
  let prepares = 0;
  const { controller, reviews } = setup({
    ensurePaired: async () => false,
    client: {
      async prepare() {
        prepares++;
        throw new BridgeError("not_paired");
      },
    },
  });
  const result = await controller.handle(sendEvent({ recipient: "12025550123", message: "hi" }) as never, tuiCtx());
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /not paired|pair/i);
  assert.equal(prepares, 1);
  assert.equal(reviews.length, 0);
});
