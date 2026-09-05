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

### Import and retry behavior

Linus scans in bounded cycles, rotating through files so a large recent session
does not block older history. Each cycle makes at most one upload request, with
up to 500 events and a 4 MiB request limit. Progress includes bytes read, events
uploaded, and the remaining queue. `--once` runs one cycle, not a full import.

Failed requests use persistent exponential backoff with jitter (up to five
minutes). Restarting preserves checkpoints and the exact in-flight batch for
safe retries. Identified rejected records are retained separately so accepted
records can drain; ambiguous receipts never delete queued data.

Scanning pauses under upload backpressure or when the local SQLite budget is
nearly full, then resumes as uploads free space. The default database budget is
256 MiB; `LINUS_MAX_QUEUE_MB` can override it (minimum 8 MiB). SQLite journal
files and the existing raw transcripts are additional disk usage. Updating
Linus preserves the queue and connection: stop the old process with Ctrl+C,
then run `npx --yes rexy-linus@latest` without a new claim token. Run only one
collector against the same data directory.

### 0.1.2

The terminal now shows cumulative uploaded events, not a counter that resets each
cycle. Use `--verbose` for bytes read, files found, extracted records and pending
uploads. These are progress counts, not a claim that full history has finished.

Re-pasting a claim for the same API resumes the saved account without redeeming
the claim again. Revoked or expired upload credentials stop with an actionable
error; queued data is kept. To connect a different account or replace a revoked
device, set `LINUS_DATA_DIR` to a new empty directory and paste a fresh command
from Rexy. The new connection imports the recognized history into that account;
the old directory remains untouched. A failed claim never silently switches APIs.
