# Security policy

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting: **Security › Report a vulnerability** on this repository. Problems in the bridge itself belong to [whatsapp-mcp](https://github.com/Gybra/whatsapp-mcp/security). Never include your WhatsApp session, tokens, phone numbers or message contents.

Only the latest version is supported.

## What this extension does

- It shows every outgoing WhatsApp message in full inside Pi and signs it only after you choose *Approve and send*. The [whatsapp-mcp](https://github.com/Gybra/whatsapp-mcp) bridge checks that signature and refuses anything else, so disabling the extension never lets a message through.
- The signing key exists only in the running Pi process. It is never written to disk, never exposed as a tool and is revoked when Pi quits or reloads.
- Pairing a Pi session with the bridge needs your confirmation once per Pi process.
- It blocks the model's file and shell tools from the bridge's credentials, session data and pairing command. Only the outbox and downloads folders stay open to it.
- It downloads the bridge only when you choose to in `/whatsapp-setup`, and checks it against the SHA-256 checksum pinned in this package.
- Without Pi's interactive terminal (print, JSON or RPC mode), sending is refused.

## Limits

- Other Pi extensions and any program running as your user share Pi's permissions and can interfere with all of the above. The tool guard is a guard rail, not a sandbox.
- WhatsApp messages are untrusted input and can try to steer the model (prompt injection). Approval stops unreviewed sends; it cannot stop you from approving a misleading message.
- Messages the model reads are sent to your model provider and stored in Pi's session files.
