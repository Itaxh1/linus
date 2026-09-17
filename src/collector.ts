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
  bytes: number;
  uploaded: number;
  quarantined: number;
  collectionPaused: boolean;
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
    if (error instanceof Error && (error as Error & { fatal?: boolean }).fatal) throw error;
    return error instanceof Error ? error.message : String(error);
  }
}

async function scanFile(
  file: SourceFile,
  outbox: Outbox,
  maxRecords: number,
  deadline: number,
): Promise<{ records: number; events: number; bytes: number }> {
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
  let bytes = 0;
  let lastTimestamp: string | undefined;
  for await (const record of scanJsonl(file.path, { startOffset: checkpoint.byteOffset })) {
    if (!record.complete || !outbox.canCollect()) break;
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
        event: file.nativeSessionId ? { ...event, native_session_id: file.nativeSessionId } : event,
      },
    }));
    if (extracted.length > 0) lastTimestamp = extracted[0]!.event.created_at;
    sequence += 1;
    records += 1;
    events += payloads.length;
    bytes += record.endOffset - record.startOffset;
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
    if (records >= maxRecords || Date.now() >= deadline) break;
  }
  return { records, events, bytes };
}

export async function collectOnce(
  credentials: Credentials,
  dataDirectory = defaultDataDirectory(),
  transcriptHome?: string,
): Promise<CycleResult> {
  const outbox = new Outbox(join(dataDirectory, "linus.sqlite3"));
  try {
    const cycleRecordLimit = 5_000;
    const files = await discoverTranscripts(credentials.installationId, transcriptHome);
    const deadline = Date.now() + 2_000;
    const lastFile = outbox.lastScannedFile();
    const lastFileIndex = files.findIndex(file => file.identityId === lastFile);
    const startIndex = lastFileIndex + 1;
    const orderedFiles = [...files.slice(startIndex), ...files.slice(0, startIndex)];
    let records = 0;
    let events = 0;
    let bytes = 0;
    let uploadError: string | null = null;
    for (const file of orderedFiles) {
      // Drain a large queue before reading further. Never advance checkpoints
      // when the disk budget is reached; original transcripts remain replayable.
      if (!outbox.canCollect() || outbox.activeCount() >= 5_000) break;
      const result = await scanFile(
        file,
        outbox,
        Math.min(500, cycleRecordLimit - records),
        deadline,
      );
      records += result.records;
      events += result.events;
      bytes += result.bytes;
      // Resume at the next file even across restarts, so large/recent files
      // cannot consume every cycle before older history gets a turn.
      outbox.markScannedFile(file.identityId);
      if (records >= cycleRecordLimit || Date.now() >= deadline) break;
    }
    const beforeUpload = outbox.count();
    uploadError = await attemptFlush(outbox, credentials);
    return { files: files.length, records, events, bytes, pending: outbox.activeCount(),
      uploaded: beforeUpload - outbox.count(), quarantined: outbox.quarantined(),
      collectionPaused: !outbox.canCollect() || outbox.activeCount() >= 5_000, uploadError };
  } finally {
    outbox.close();
  }
}
