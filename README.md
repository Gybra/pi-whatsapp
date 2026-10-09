# pi-whatsapp

Read and search your WhatsApp conversations from [Pi](https://pi.dev), and send messages only after you approve each one inside Pi's terminal.

> **Status: pre-release.** Not yet published to npm. It works with the [`whatsapp-mcp`](https://github.com/Gybra/whatsapp-mcp) bridge, which is also unreleased.
>
> This is an unofficial WhatsApp integration, not affiliated with WhatsApp or Meta. Using unofficial clients can lead to account restrictions.

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

1. Install and set up the bridge, following its README.
2. Install the extension:

   ```sh
   pi install npm:pi-whatsapp   # once published
   ```

3. In Pi, run `/whatsapp-setup` and enter the absolute path of the `whatsapp-mcp` executable. Pi then starts `whatsapp-mcp mcp` for its sessions. Your `settings.json` and `mcp.json` are not changed. If `mcp.json` already defines a `whatsapp` server, it is left alone and takes precedence.
4. Run `/whatsapp-pair` and follow the steps: run `whatsapp-mcp setup --pair-pi` in a separate terminal, paste the public key Pi shows, and confirm that the fingerprints match.

Pairing is needed once per Pi process. It survives `/new` and `/resume`, and ends when Pi quits or reloads; Pi then reminds you to run `/whatsapp-pair` again. It cannot outlive Pi because the approval key is never saved to disk: a saved key could be read and used by the model through Pi's shell tools, bypassing your approval. `/whatsapp-status` shows the bridge state and whether this session is paired.

The extension stores only the bridge path, in `pi-whatsapp.json` in Pi's agent directory. The approval key is never written to disk.

## Security notes

- The bridge enforces approval. Disabling this extension never lets a message through; it only removes the way to approve one.
- WhatsApp messages and contact names are untrusted input. They can contain instructions aimed at the model (prompt injection). The approval screen exists so that nothing is sent on the model's word alone. Read what you approve.
- Messages that Pi reads become part of the conversation sent to your model provider and saved in Pi's session files.
- This design protects against the model and against other local programs using the bridge's API. It does not protect against a program running as your user that can change the bridge, its data or Pi itself.

## Development

```sh
npm install --no-package-lock --ignore-scripts
npm run typecheck
npm test
```

## License

MIT
