#!/usr/bin/env node
import { exchangeClaim } from "./claim.js";
import { collectOnce } from "./collector.js";
import { defaultDataDirectory, loadCredentials } from "./config.js";

const VERSION = "0.1.1";

interface Arguments {
  api?: string;
  claim?: string;
  once: boolean;
  help: boolean;
  version: boolean;
}

function parseArguments(values: string[]): Arguments {
  const result: Arguments = { once: false, help: false, version: false };
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
    "  linus [--once]",
    "  linus --help",
    "  linus --version",
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

  const dataDirectory = defaultDataDirectory();
  let credentials = await loadCredentials(dataDirectory);
  if (args.api && args.claim) {
    credentials = await exchangeClaim(args.api, args.claim, dataDirectory);
    console.log(`Connected device ${credentials.deviceId}`);
  }
  if (!credentials) throw new Error("Linus is not connected; paste the command from Rexy");
  console.log("Scanning local history. Upload progress follows; keep this terminal open.");

  do {
    const result = await collectOnce(credentials, dataDirectory);
    console.log(
      `Scanned ${result.files} files, ${result.records} new records, ` +
      `${result.events} timeline events, ${result.pending} pending uploads ` +
      `(${(result.bytes / 1024 / 1024).toFixed(1)} MiB read, ${result.uploaded} uploaded)`,
    );
    if (result.uploadError) console.error(`Upload deferred: ${result.uploadError}`);
    if (result.quarantined) console.error(`${result.quarantined} rejected records retained locally for inspection; other uploads continue.`);
    if (result.collectionPaused) console.error("Local queue limit reached; scanning paused while uploads drain. No history was deleted.");
    if (args.once) break;
    if ((result.records === 0 && result.uploaded === 0) || result.uploadError) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
  } while (true);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`linus: ${message}`);
  process.exitCode = 1;
});
