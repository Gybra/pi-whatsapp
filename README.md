# pi-whatsapp

Read and search your WhatsApp conversations from [Pi](https://pi.dev), and send messages only after you approve each one inside Pi's terminal.

> This is an unofficial WhatsApp integration, not affiliated with WhatsApp or Meta. Using unofficial clients can lead to account restrictions.

## Platform support

| Platform | Status |
|---|---|
| macOS (Apple Silicon) | Automated tests pass. End-to-end verification with a real account is in progress. |
| Linux | Developed for it, automated tests run in CI. Not yet tested end to end. |
| Windows | **Experimental.** Developed for it, not yet tested end to end. |

It needs the [whatsapp-mcp](https://github.com/Gybra/whatsapp-mcp) bridge, which `/whatsapp-setup` can download for you.

## How it works

- The **whatsapp-mcp bridge** (a separate Go program) connects to your WhatsApp account and serves the WhatsApp tools to Pi over MCP. It refuses to send anything without a signed approval for that exact message.
- **This extension** shows you each outgoing message in full before it is sent. Choosing *Approve and send* signs that one message with a key that exists only in this Pi process.

Reading and searching need no approval. Every text, file or voice message does, one at a time:

1. Pi asks to send a message.
2. The bridge freezes the exact recipient, text and attachment bytes.
3. You review all of it in Pi. Control and invisible characters are shown as `⟨U+…⟩`, and *Cancel* is selected by default.
4. Only after you approve does the bridge send. Each approval is single-use and expires after 120 seconds.

If you decline, Pi is told the message was not sent. Without Pi's interactive terminal (print, JSON or RPC mode), sending is refused.

## Setup

Everything happens inside Pi; no second terminal is needed.

1. Install the extension:

   ```sh
   pi install npm:pi-whatsapp   # once published
   ```

2. In Pi, run `/whatsapp-setup`. It:
   - downloads the `whatsapp-mcp` bridge for your system and checks it against the SHA-256 checksum pinned in this package. You can instead point it at a bridge you built yourself: `/whatsapp-setup /path/to/whatsapp-mcp`;
   - shows a QR code in Pi to link this computer to your WhatsApp account. Scan it on your phone under *Settings › Linked devices › Link a device*;
   - asks whether the bridge should start automatically when you log in, run until you log out, or not start yet. Nothing runs in the background without your choice;
   - makes the WhatsApp tools available to Pi. Your `settings.json` and `mcp.json` are not changed. If `mcp.json` already defines a `whatsapp` server, it is left alone and takes precedence.

3. Ask Pi to read or send WhatsApp messages. Before the first message in a Pi session, Pi asks once whether this session may approve messages. After that, every message is still shown to you for approval.

The approval key exists only in the running Pi process and is never written to disk. When Pi quits or reloads, the bridge stops trusting it, and the next session asks again. `/whatsapp-pair` asks right away instead of at the first message. `/whatsapp-status` shows the bridge state, whether WhatsApp is linked and whether this session can approve messages.

To send a file, copy it into the bridge's `outbox` folder first and ask Pi to send it by name. The folder is under the bridge's data directory, shown by `whatsapp-mcp status`.

## Security notes

- The bridge enforces approval. Disabling this extension never lets a message through; it only removes the way to approve one.
- WhatsApp messages and contact names are untrusted input. They can contain instructions aimed at the model (prompt injection). The approval screen exists so that nothing is sent on the model's word alone. Read what you approve.
- Messages that Pi reads become part of the conversation sent to your model provider and saved in Pi's session files.
- The extension blocks the model's file and shell tools from the bridge's credentials, session data and pairing command. This stops the direct routes a manipulated model would try, but it is not a sandbox.
- This design protects against the model and against other local programs using the bridge's API. It does not protect against a program running as your user that can change the bridge, its data or Pi itself.

## Development

```sh
npm install --no-package-lock --ignore-scripts
npm run typecheck
npm test
```

## License

MIT
