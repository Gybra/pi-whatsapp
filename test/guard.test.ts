import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { protectedToolCall } from "../src/guard.ts";

const paths = {
  dataDir: "/Users/ada/Library/Application Support/whatsapp-mcp",
  installDir: "/Users/ada/.pi/agent/pi-whatsapp-bridge",
  configFile: "/Users/ada/.pi/agent/pi-whatsapp.json",
  bridgePath: "/opt/tools/whatsapp-mcp",
};

const call = (toolName: string, input: Record<string, unknown>) => protectedToolCall({ toolName, input }, paths);

test("blocks model access to bridge credentials, sessions and pairing", () => {
  for (const [tool, input] of [
    ["read", { path: join(paths.dataDir, "api-token") }],
    ["read", { path: "~/Library/Application Support/whatsapp-mcp/approver.json" }],
    ["bash", { command: 'cat "$HOME/Library/Application Support/whatsapp-mcp/api-token"' }],
    ["bash", { command: "sqlite3 ~/.local/share/whatsapp-mcp/messages.db .dump" }],
    ["powershell", { command: "Get-Content $env:LOCALAPPDATA\\whatsapp-mcp\\api-token" }],
    ["bash", { command: "echo KEY= | /opt/tools/whatsapp-mcp pair-pi" }],
    ["bash", { command: "whatsapp-mcp pair-pi < key.txt" }],
    ["bash", { command: "cp /tmp/evil ~/.pi/agent/pi-whatsapp-bridge/1.0.0/whatsapp-mcp" }],
    ["write", { path: paths.configFile, content: "{}" }],
    ["bash", { command: "cat ~/Library/Application\\ Support/whatsapp-mcp/outbox/../api-token" }],
    ["grep", { pattern: "x", path: "/Users/ada/Library/Application Support/whatsapp-mcp" }],
  ] as const) {
    assert.ok(call(tool, input as Record<string, unknown>), `${tool} ${JSON.stringify(input)} was allowed`);
  }
});

test("allows the outbox and ordinary work, including this repository", () => {
  for (const [tool, input] of [
    ["bash", { command: `cp report.pdf "${paths.dataDir}/outbox/report.pdf"` }],
    ["write", { path: join(paths.dataDir, "outbox", "notes.txt"), content: "hi" }],
    ["bash", { command: "go test ./... && git status" }],
    ["read", { path: "/Users/ada/Documents/GO/whatsapp-mcp/whatsapp-bridge/api.go" }],
    ["bash", { command: "/opt/tools/whatsapp-mcp status" }],
    ["edit", { path: "/Users/ada/Documents/pi-whatsapp/src/guard.ts", edits: [{ oldText: "a", newText: "Application Support/whatsapp-mcp pair-pi" }] }],
    ["write", { path: "/Users/ada/Documents/notes.md", content: "approver.json lives in Application Support/whatsapp-mcp" }],
  ] as const) {
    assert.equal(call(tool, input as Record<string, unknown>), undefined, `${tool} ${JSON.stringify(input)} was blocked`);
  }
});

test("lets the model read downloaded attachments, such as voice messages", () => {
  assert.equal(call("read", { path: join(paths.dataDir, "downloads", "9f2c.ogg") }), undefined);
  assert.equal(call("bash", { command: 'ffprobe "$HOME/Library/Application Support/whatsapp-mcp/downloads/9f2c.ogg"' }), undefined);
  assert.ok(call("read", { path: join(paths.dataDir, "downloads", "..", "api-token") }));
});

test("an unknown data directory never blocks everything", () => {
  const unknown = { ...paths, dataDir: "" };
  assert.equal(protectedToolCall({ toolName: "bash", input: { command: "ls -la" } }, unknown), undefined);
  assert.ok(protectedToolCall({ toolName: "bash", input: { command: "cat ~/.local/share/whatsapp-mcp/api-token" } }, unknown));
});

test("ignores other tools, including the WhatsApp MCP tools themselves", () => {
  assert.equal(call("mcp__whatsapp__list_messages", { query: "api-token" }), undefined);
  assert.equal(call("mcp__github__search", { q: "approver.json" }), undefined);
});
