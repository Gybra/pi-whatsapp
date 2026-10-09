import { Agent, request } from "node:http";
import type { SendInput } from "./protocol.ts";

// The bridge listens on this fixed loopback address and rejects any other Host header.
const API_HOST = "127.0.0.1:8080";
const JSON_LIMIT = 4 * 1024 * 1024;
const PREVIEW_LIMIT = 16 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const DRAFT_ID = /^[0-9a-f]{32}$/;
const STATES = ["unpaired", "connecting", "online", "offline", "action_required", "stopped"] as const;

export type RuntimeStatus = {
  state: (typeof STATES)[number];
  connected: boolean;
  approver_id: string;
};

export type BridgeClient = {
  status(signal?: AbortSignal): Promise<RuntimeStatus>;
  /** Returns the bridge's draft as received; callers validate it with decodeDraft. */
  prepare(input: SendInput, signal: AbortSignal): Promise<unknown>;
  cancel(draftID: string, signal?: AbortSignal): Promise<void>;
  revoke(signal?: AbortSignal): Promise<void>;
  preview(draftID: string, signal: AbortSignal): Promise<Uint8Array>;
};

/** A failed bridge call. `code` is the bridge's fixed error code, or a local one such as "unreachable". */
export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`WhatsApp bridge error: ${code}`);
    this.code = code;
  }
}

/**
 * Talks to the bridge's loopback API. Requests are never retried or redirected,
 * and never go through a proxy: a dedicated agent ignores proxy settings.
 * `port` exists only so tests can reach a fake bridge.
 */
export function createBridgeClient(token: Uint8Array, options: { port?: number } = {}): BridgeClient {
  if (token.length !== 32) throw new Error("the bridge API token must be 32 bytes");
  const authorization = `Bearer ${Buffer.from(token).toString("hex")}`;
  const port = options.port ?? 8080;
  const agent = new Agent({ keepAlive: false });

  function call(method: string, path: string, body: unknown, signal: AbortSignal | undefined, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const headers: Record<string, string | number> = { Host: API_HOST, Authorization: authorization };
      if (payload) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": payload.length });
      const req = request({ host: "127.0.0.1", port, method, path, headers, agent, signal, timeout: TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            req.destroy(new BridgeError("bad_response"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const data = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(data);
          else reject(new BridgeError(errorCode(data)));
        });
        res.on("error", (error) => reject(toBridgeError(error, signal)));
      });
      req.on("timeout", () => req.destroy(new BridgeError("timeout")));
      req.on("error", (error) => reject(toBridgeError(error, signal)));
      req.end(payload);
    });
  }

  async function callJSON(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const data = await call(method, path, body, signal, JSON_LIMIT);
    if (data.length === 0) return undefined;
    try {
      return JSON.parse(data.toString("utf8"));
    } catch {
      throw new BridgeError("bad_response");
    }
  }

  function draftPath(draftID: string, suffix = ""): string {
    if (!DRAFT_ID.test(draftID)) throw new BridgeError("invalid_request");
    return `/api/drafts/${draftID}${suffix}`;
  }

  return {
    async status(signal) {
      return parseStatus(await callJSON("GET", "/api/status", undefined, signal));
    },
    prepare(input, signal) {
      return callJSON("POST", "/api/drafts", input, signal);
    },
    async cancel(draftID, signal) {
      await callJSON("DELETE", draftPath(draftID), undefined, signal);
    },
    async revoke(signal) {
      await callJSON("DELETE", "/api/approver", undefined, signal);
    },
    async preview(draftID, signal) {
      return call("GET", draftPath(draftID, "/preview"), undefined, signal, PREVIEW_LIMIT);
    },
  };
}

function parseStatus(value: unknown): RuntimeStatus {
  const s = value as Record<string, unknown>;
  const valid =
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(s).sort().join() === "approver_id,connected,state" &&
    STATES.includes(s.state as RuntimeStatus["state"]) &&
    typeof s.connected === "boolean" &&
    typeof s.approver_id === "string" && /^([0-9a-f]{64})?$/.test(s.approver_id);
  if (!valid) throw new BridgeError("bad_response");
  return s as RuntimeStatus;
}

function errorCode(data: Buffer): string {
  try {
    const code = (JSON.parse(data.toString("utf8")) as { error?: unknown }).error;
    if (typeof code === "string" && /^[a-z_]{1,32}$/.test(code)) return code;
  } catch {
    // fall through
  }
  return "bad_response";
}

function toBridgeError(error: unknown, signal: AbortSignal | undefined): BridgeError {
  if (error instanceof BridgeError) return error;
  return new BridgeError(signal?.aborted ? "aborted" : "unreachable");
}
