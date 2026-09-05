/** Terminal output for Linus.
 *
 *  Default is a single self-updating line carrying the only number that means
 *  anything to a person: how many events have reached Rexy. Everything else —
 *  files, bytes, records extracted — moves behind --verbose.
 *
 *  The headline counts UPLOADED events, not extracted ones. Extraction goes to
 *  zero as soon as every file sits at its checkpoint, so a counter built on it
 *  reads as stalled while the outbox is still draining.
 *
 *  Falls back to occasional plain lines when stdout is not a TTY, so piping to a
 *  file or a CI log does not produce thousands of escape sequences. */

const TTY = process.stdout.isTTY === true;
const COLOR = TTY && !process.env.NO_COLOR;

const g = (s: string) => (COLOR ? `\x1b[38;5;42m${s}\x1b[0m` : s);   // green
const dim = (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (COLOR ? `\x1b[38;5;203m${s}\x1b[0m` : s);
const bold = (s: string) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s);

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const n = (value: number) => value.toLocaleString("en-US");

export interface Totals {
  events: number;
  uploaded: number;
  pending: number;
  files: number;
  bytes: number;
}

export class Ui {
  private frame = 0;
  private painted = false;
  private lastPlain = 0;
  private timer: NodeJS.Timeout | null = null;
  private status: string | null = null;
  private failing = false;

  constructor(private readonly verbose: boolean) {}

  /** Keeps the spinner moving while a slow cycle is in flight. */
  start(totals: Totals): void {
    if (!TTY || this.verbose || this.timer) return;
    this.timer = setInterval(() => this.paint(totals), 90);
    this.timer.unref?.();
  }

  stopSpinner(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  note(message: string): void {
    this.clear();
    process.stdout.write(`${message}\n`);
    this.painted = false;
  }

  update(totals: Totals, cycle: {
    records: number; uploadError: string | null;
    quarantined: number; collectionPaused: boolean;
  }): void {
    this.failing = cycle.uploadError !== null;
    this.status = cycle.uploadError
      ? `retrying upload — ${cycle.uploadError.replace(/^upload failed with /, "")}`
      : cycle.collectionPaused ? "local queue full, waiting for uploads to drain"
      : cycle.quarantined > 0 ? `${n(cycle.quarantined)} records held back`
      : null;

    if (this.verbose) {
      this.line(
        `uploaded ${n(totals.uploaded)} · extracted ${n(totals.events)} · pending ${n(totals.pending)} · ` +
        `records ${n(cycle.records)} · files ${n(totals.files)} · ${(totals.bytes / 1048576).toFixed(1)} MiB` +
        (this.status ? ` · ${this.status}` : ""),
      );
      return;
    }
    if (!TTY) {
      // Plain mode: one line every 10s, so logs stay readable.
      const now = Date.now();
      if (now - this.lastPlain < 10_000 && !this.failing) return;
      this.lastPlain = now;
      this.line(`${n(totals.uploaded)} events tracked${this.status ? ` — ${this.status}` : ""}`);
      return;
    }
    this.paint(totals);
  }

  /** Final line, left on screen. */
  done(totals: Totals): void {
    this.stopSpinner();
    this.clear();
    const held = totals.pending > 0 ? dim(`  ${n(totals.pending)} still queued`) : "";
    process.stdout.write(`${g("●")} ${bold(n(totals.uploaded))} events tracked${held}\n`);
  }

  private paint(totals: Totals): void {
    if (!TTY || this.verbose) return;
    const mark = this.failing ? red(FRAMES[this.frame % FRAMES.length]!)
                              : g(FRAMES[this.frame % FRAMES.length]!);
    this.frame += 1;
    const tail = this.status ? dim(` · ${this.status}`)
               : totals.pending > 0 ? dim(` · ${n(totals.pending)} queued`)
               : "";
    this.clear();
    process.stdout.write(`${mark} ${bold(n(totals.uploaded))} ${dim("events tracked")}${tail}`);
    this.painted = true;
  }

  private clear(): void {
    if (TTY && this.painted) process.stdout.write("\r\x1b[2K");
    this.painted = false;
  }

  private line(text: string): void {
    this.clear();
    process.stdout.write(`${text}\n`);
  }
}
