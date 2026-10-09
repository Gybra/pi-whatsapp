# Contributing

Bug reports from Windows are especially welcome: it is not yet tested end to end.

Report problems with the issue form, giving your OS, architecture, Pi version, `pi-whatsapp` version and `whatsapp-mcp version`. Remove anything personal from logs. Security problems go through private reporting; see [SECURITY.md](SECURITY.md).

## Development

Node.js 22.19 or later:

```sh
npm install --no-package-lock --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run          # check that only the intended files are published
```

Try a local checkout in Pi with `pi -e /path/to/pi-whatsapp`. The bridge repository has a dry-run mode for testing without a WhatsApp account; see its `docs/manual-verification.md`.

Ground rules:

- Never expose signing, approval or pairing as a tool the model can call, and never persist the signing key.
- Never show a truncated or summarised message for approval.
- Never change the user's Pi settings or `mcp.json`.
- Tests never use a real WhatsApp account.
- Use one-line conventional commit messages.

## Releasing

1. Publish a whatsapp-mcp release, then pin its checksums: `node scripts/update-bridge-release.mjs <version> SHA256SUMS`.
2. Run the checks above and inspect `npm pack --dry-run`.
3. Publish with `npm publish`.
