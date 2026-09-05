# Rexy Linus

Linus is the local Claude Code and Codex activity collector for the Rexy dashboard.
It streams recognized JSONL transcript files, redacts bounded previews, and uploads
normalized timeline events. Full raw transcripts remain on the machine.

Requires Node.js 22.13 or newer and npm. Sign in at
[Rexy](https://rexy.baememory.com), then copy your personalized install command.
It contains a short-lived, single-use claim token that connects this machine to
your account. Keep that token private.

The command has this shape; replace the placeholder with the token from Rexy:

```sh
npx --yes rexy-linus@latest --claim <one-time-claim> --api https://rexy-api.baememory.com
```

Leave the terminal running to collect existing history and watch for new
activity. Press Ctrl+C to stop. This version does not install a background
service. To resume later:

```sh
npx --yes rexy-linus@latest
```

Use `npx --yes rexy-linus@latest --once` for one collection cycle, or `--help`
for usage. An optional global installation (`npm install -g rexy-linus`)
also makes the `linus` command available directly.

Linus reads recognized Claude Code and Codex transcript locations. Normalized
events and bounded, redacted content previews are uploaded to Rexy; redaction
cannot guarantee removal of every secret. Original raw files remain local.
Connection credentials, checkpoints, and queued uploads live in `~/.linus`.
No transcript collection or account connection runs during npm installation.
