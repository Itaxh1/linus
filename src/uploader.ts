import { randomUUID } from "node:crypto";
import type { Credentials } from "./config.js";
import type { Outbox } from "./outbox.js";

export interface IngestReceipt {
  batch_id: string;
  accepted: number;
  duplicate: number;
  rejected: number;
}

export async function flushOutbox(
  outbox: Outbox,
  credentials: Credentials,
): Promise<IngestReceipt | null> {
  const pending = outbox.pending(500);
  if (pending.length === 0) return null;
  const batchId = randomUUID();
  const body = {
    protocol_version: 1,
    batch_id: batchId,
    device_sequence: outbox.nextBatchSequence(),
    extractor_version: 1,
    records: pending.map((record) => record.payload),
  };
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) {
    throw new Error("outbox batch exceeds the 4 MiB request limit");
  }
  const response = await fetch(`${credentials.apiBase}/v1/ingest/batches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.deviceToken}`,
      "content-type": "application/json",
    },
    body: encoded,
  });
  if (!response.ok) throw new Error(`upload failed with HTTP ${response.status}`);
  const receipt = await response.json() as IngestReceipt;
  if (receipt.rejected !== 0) throw new Error(`backend rejected ${receipt.rejected} records`);
  outbox.acknowledge(pending.map((record) => record.id));
  return receipt;
}
