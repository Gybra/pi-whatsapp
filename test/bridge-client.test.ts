import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BridgeError, createBridgeClient } from "../src/bridge-client.ts";

const TOKEN = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const INPUT = { kind: "text", recipient: "12025550123", message: "hi", media_id: "" } as const;

type Seen = { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string };

async function fakeBridge(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const seen = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(seen);
      handler(req, res, seen);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { client: createBridgeClient(TOKEN, { port }), requests, close: () => server.close() };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

test("authenticates to the fixed loopback address and posts the exact input", async () => {
  const bridge = await fakeBridge((_req, res) => json(res, 201, { draft_id: "x" }));
  try {
    assert.deepEqual(await bridge.client.prepare(INPUT, AbortSignal.timeout(5000)), { draft_id: "x" });
    const [seen] = bridge.requests;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/drafts");
    assert.equal(seen.headers.host, "127.0.0.1:8080", "the bridge only accepts its own Host header");
    assert.equal(seen.headers.authorization, `Bearer ${Buffer.from(TOKEN).toString("hex")}`);
    assert.equal(seen.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(seen.body), INPUT);
  } finally {
    bridge.close();
  }
});

test("surfaces the bridge error code and nothing else", async () => {
  const bridge = await fakeBridge((_req, res) => json(res, 409, { error: "not_paired", message: "detail" }));
  try {
    await assert.rejects(bridge.client.prepare(INPUT, AbortSignal.timeout(5000)), (error: unknown) => error instanceof BridgeError && error.code === "not_paired");
  } finally {
    bridge.close();
  }
});

test("does not follow redirects or accept oversized responses", async () => {
  const redirect = await fakeBridge((_req, res) => {
    res.writeHead(307, { Location: "http://attacker.example/api/drafts" });
    res.end();
  });
  try {
    await assert.rejects(redirect.client.prepare(INPUT, AbortSignal.timeout(5000)), BridgeError);
    assert.equal(redirect.requests.length, 1);
  } finally {
    redirect.close();
  }

  const huge = await fakeBridge((_req, res) => json(res, 200, { padding: "x".repeat(5 * 1024 * 1024) }));
  try {
    // prepare returns the raw body, so only the size limit can reject it
    await assert.rejects(huge.client.prepare(INPUT, AbortSignal.timeout(5000)), (error: unknown) => error instanceof BridgeError && error.code === "bad_response");
  } finally {
    huge.close();
  }
});

test("never retries a write after a dropped connection", async () => {
  const bridge = await fakeBridge((req) => req.socket.destroy());
  try {
    await assert.rejects(bridge.client.prepare(INPUT, AbortSignal.timeout(5000)), (error: unknown) => error instanceof BridgeError && error.code === "unreachable");
    assert.equal(bridge.requests.length, 1);
  } finally {
    bridge.close();
  }
});

test("can be aborted", async () => {
  const bridge = await fakeBridge(() => {}); // never answers
  try {
    const controller = new AbortController();
    const pending = bridge.client.prepare(INPUT, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error: unknown) => error instanceof BridgeError && error.code === "aborted");
  } finally {
    bridge.close();
  }
});

test("validates status responses", async () => {
  const good = { state: "online", connected: true, approver_id: "a".repeat(64)};
  const bridge = await fakeBridge((_req, res) => json(res, 200, good));
  try {
    assert.deepEqual(await bridge.client.status(AbortSignal.timeout(5000)), good);
  } finally {
    bridge.close();
  }
  for (const bad of [{ ...good, state: "hacked" }, { ...good, connected: "yes" }, { ...good, approver_expires_at: 1 }, []]) {
    const other = await fakeBridge((_req, res) => json(res, 200, bad));
    try {
      await assert.rejects(other.client.status(AbortSignal.timeout(5000)), BridgeError);
    } finally {
      other.close();
    }
  }
});

test("fetches previews as bytes and addresses drafts by validated id", async () => {
  const bridge = await fakeBridge((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 255]));
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  const id = "0123456789abcdef0123456789abcdef";
  try {
    assert.deepEqual(Buffer.from(await bridge.client.preview(id, AbortSignal.timeout(5000))), Buffer.from([0, 1, 2, 255]));
    await bridge.client.cancel(id);
    await bridge.client.revoke();
    assert.deepEqual(
      bridge.requests.map((r) => `${r.method} ${r.url}`),
      [`GET /api/drafts/${id}/preview`, `DELETE /api/drafts/${id}`, "DELETE /api/approver"],
    );
    await assert.rejects(bridge.client.preview("../approver", AbortSignal.timeout(5000)), BridgeError);
    assert.equal(bridge.requests.length, 3);
  } finally {
    bridge.close();
  }
});

test("rejects a token of the wrong size", () => {
  assert.throws(() => createBridgeClient(new Uint8Array(16)));
});
