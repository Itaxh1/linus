import { join } from "node:path";
import type { Credentials } from "./config.js";
import { defaultDataDirectory } from "./config.js";
import { discoverTranscripts, type SourceFile } from "./discovery.js";
import { extractEvents } from "./extractor.js";
import { Outbox } from "./outbox.js";
import { scanJsonl } from "./scanner.js";
import { flushOutbox } from "./uploader.js";

export interface CycleResult {
  files: number;
  records: number;
  events: number;
  pending: number;
  uploadError: string | null;
}

async function attemptFlush(
  outbox: Outbox,
  credentials: Credentials,
): Promise<string | null> {
  try {
    await flushOutbox(outbox, credentials);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function scanFile(
  file: SourceFile,
  outbox: Outbox,
  credentials: Credentials,
  maxRecords: number,
): Promise<{ records: number; events: number }> {
  const checkpoint = outbox.resolveSourceFile({
    identityId: file.identityId,
    path: file.path,
    source: file.source,
    size: file.size,
  });
  const sourceFileId = checkpoint.sourceFileId;
  let sequence = checkpoint.nextSequence;
  let records = 0;
  let events = 0;
  let lastTimestamp: string | undefined;
  for await (const record of scanJsonl(file.path, { startOffset: checkpoint.byteOffset })) {
    if (!record.complete) break;
    const extracted = extractEvents(file.source, sourceFileId, record, lastTimestamp);
    const payloads = extracted.map(({ itemIndex, event }) => ({
      itemIndex,
      payload: {
        source: file.source,
        source_file_id: sourceFileId,
        sequence,
        item_index: itemIndex,
        revision: 1,
        stage: "enriched",
        payload_hash: record.hash,
        event,
      },
    }));
    if (extracted.length > 0) lastTimestamp = extracted[0]!.event.created_at;
    sequence += 1;
    records += 1;
    events += payloads.length;
    outbox.commitRecord({
      sourceFileId,
      identityId: file.identityId,
      generation: checkpoint.generation,
      path: file.path,
      source: file.source,
      size: file.size,
      nextOffset: record.endOffset,
      nextSequence: sequence,
      payloadHash: record.hash,
      payloads,
    });
    if (records % 500 === 0) await attemptFlush(outbox, credentials);
    if (records >= maxRecords) break;
  }
  return { records, events };
}

export async function collectOnce(
  credentials: Credentials,
  dataDirectory = defaultDataDirectory(),
): Promise<CycleResult> {
  const outbox = new Outbox(join(dataDirectory, "linus.sqlite3"));
  try {
    const cycleRecordLimit = 500;
    const files = await discoverTranscripts(credentials.installationId);
    let records = 0;
    let events = 0;
    let uploadError: string | null = null;
    for (const file of files) {
      const result = await scanFile(
        file,
        outbox,
        credentials,
        cycleRecordLimit - records,
      );
      records += result.records;
      events += result.events;
      uploadError = await attemptFlush(outbox, credentials);
      if (records >= cycleRecordLimit) break;
    }
    while (!uploadError && outbox.count() > 0) {
      uploadError = await attemptFlush(outbox, credentials);
    }
    return { files: files.length, records, events, pending: outbox.count(), uploadError };
  } finally {
    outbox.close();
  }
}
