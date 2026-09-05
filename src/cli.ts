#!/usr/bin/env node
import { exchangeClaim } from "./claim.js";
import { collectOnce } from "./collector.js";
import { defaultDataDirectory, loadCredentials, validateApiBase } from "./config.js";
import { Ui, type Totals } from "./ui.js";

const VERSION = "0.1.2";

interface Arguments {
  api?: string;
  claim?: string;
  once: boolean;
  help: boolean;
  version: boolean;
  verbose: boolean;
  reconnect: boolean;
}

function parseArguments(values: string[]): Arguments {
  const result: Arguments = { once: false, help: false, version: false, verbose: false, reconnect: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--api" || value === "--claim") {
      const argument = values[index + 1];
      if (!argument) throw new Error(`${value} requires a value`);
      if (value === "--api") result.api = argument;
      else result.claim = argument;
      index += 1;
    }
    else if (value === "--once") result.once = true;
    else if (value === "--verbose" || value === "-V") result.verbose = true;
    else if (value === "--reconnect") result.reconnect = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--version" || value === "-v") result.version = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function usage(): string {
  return [
    "Linus records coding-agent timeline events and uploads normalized metadata.",
    "",
    "First connection:",
    "  linus --claim <single-use-token> --api <https-url>",
    "",
    "Run:",
    "  linus [--once] [--verbose]",
    "",
    "Re-running the command from Rexy is safe: an already-connected device keeps",
    "its stored token and simply resumes where it stopped.",
    "",
    "Options:",
    "  --verbose, -V   per-cycle detail instead of the live counter",
    "  --reconnect     pair in a fresh LINUS_DATA_DIR; existing queues are never reassigned",
    "  --once          run one collection cycle and exit",
    "  --help, -h      show this message",
    "  --version, -v   print the version",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }
  if ((args.api && !args.claim) || (args.claim && !args.api)) {
    throw new Error("--api and --claim must be supplied together");
  }
  if (args.reconnect && !args.claim) throw new Error("--reconnect requires the new --claim and --api from Rexy");

  const dataDirectory = defaultDataDirectory();
  let credentials = await loadCredentials(dataDirectory);
  let paired = false;

  if (args.api && args.claim) {
    // A claim is single-use with a ten-minute life, so re-running the command
    // Rexy handed out would otherwise fail on an already-spent token. If this
    // machine is already paired to the same backend, keep the stored device
    // token (good for 90 days) and just resume.
    const wanted = validateApiBase(args.api);
    const alreadyPaired = credentials?.apiBase === wanted;
    if (alreadyPaired && !args.reconnect) {
      console.log("Already connected to the saved Rexy account. Resuming; the pasted claim was not used.");
    } else {
      if (credentials) {
        throw new Error("Use a fresh LINUS_DATA_DIR to pair another device/account or API. Existing credentials and queued history were not changed.");
      }
      credentials = await exchangeClaim(args.api, args.claim, dataDirectory);
      paired = true;
    }
  }
  if (!credentials) throw new Error("Linus is not connected; paste the command from Rexy");

  const ui = new Ui(args.verbose);
  if (paired) ui.note("Connected. Reading your history — keep this open.");

  // Counters are cumulative across cycles; a per-cycle number resets constantly
  // and reads as though nothing is progressing.
  const totals: Totals = { events: 0, uploaded: 0, pending: 0, files: 0, bytes: 0 };

  do {
    ui.start(totals);
    const result = await collectOnce(credentials, dataDirectory).finally(() => ui.stopSpinner());
    totals.events += result.events;
    totals.uploaded += result.uploaded;
    totals.bytes += result.bytes;
    totals.pending = result.pending;
    totals.files = result.files;
    ui.update(totals, result);
    if (args.once) break;
    if ((result.records === 0 && result.uploaded === 0) || result.uploadError) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
  } while (true);

  ui.done(totals);
}

process.on("SIGINT", () => {
  process.stdout.write("\n");
  process.exit(0);
});

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write("\n");
  console.error(`linus: ${message}`);
  process.exitCode = 1;
});
