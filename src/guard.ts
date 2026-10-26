// Keeps the model away from the bridge's credentials, session and pairing.
// It inspects the paths and commands of Pi's file and shell tools. A determined
// process running as the user can still reach these files; this only stops the
// direct routes a prompt-injected model would try first.

type GuardPaths = { dataDir: string; installDir: string; configFile: string };

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
// The bridge data directory as written with ~, $HOME or %LOCALAPPDATA%, on each OS.
const DATA_DIR_SUFFIXES = ["application support/whatsapp-mcp", ".local/share/whatsapp-mcp", "appdata/local/whatsapp-mcp", "localappdata/whatsapp-mcp"];

const normalize = (s: string) => s.replace(/\\ /g, " ").replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns why the call is blocked, or undefined when it may run. */
export function protectedToolCall(event: { toolName: string; input: Record<string, unknown> }, paths: GuardPaths): string | undefined {
  const field = PATH_TOOLS.has(event.toolName) ? "path" : COMMAND_TOOLS.has(event.toolName) ? "command" : undefined;
  const value = field && event.input[field];
  if (typeof value !== "string") return undefined;
  const dataRoots = [normalize(paths.dataDir), ...DATA_DIR_SUFFIXES].filter(Boolean);
  let text = normalize(value);
  // The outbox holds files staged for sending (each still reviewed by the user) and
  // downloads holds received attachments the user may ask the model to work with.
  for (const root of dataRoots) {
    text = text.replace(new RegExp(`${escapeRegExp(root)}/(?:outbox|downloads)(?:/[^\\s"'\`;|&]*)?`, "g"), (match) => (match.includes("..") ? match : ""));
  }
  // The install directory and config file also match by name, so ~ or $HOME spellings are caught.
  const protectedRoots = [...dataRoots, normalize(paths.installDir), normalize(paths.configFile), "pi-whatsapp-bridge", "pi-whatsapp.json"].filter(Boolean);
  if (protectedRoots.some((root) => text.includes(root)) || (field === "command" && /(^|[\s/"'])pair-pi\b/.test(text))) {
    return "Blocked: the WhatsApp bridge's credentials, session and pairing are off limits to the model. Only the bridge's outbox and downloads folders may be used. Ask the user to do this themselves.";
  }
  return undefined;
}
