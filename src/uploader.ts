import { randomUUID } from "node:crypto";
import type { Credentials } from "./config.js";
import type { Outbox } from "./outbox.js";

export interface IngestReceipt {
  batch_id: string;
  accepted: number;
  duplicate: number;
  rejected: number;
  record_results?: Array<{ index: number; status: "accepted" | "duplicate" | "rejected" }>;
}

export async function flushOutbox(
  outbox: Outbox,
  credentials: Credentials,
): Promise<IngestReceipt | null> {
  let delivery = outbox.delivery();
  if (delivery && delivery.availableAt > Date.now()) return null;
  if (!delivery) {
    let pending = outbox.pending(500);
    if (pending.length === 0) return null;
    if (pending[0]!.attempts > 0) pending = pending.slice(0, 1);
    const body = {
      protocol_version: 1, batch_id: randomUUID(),
      device_sequence: outbox.nextBatchSequence(), extractor_version: 1,
      records: pending.map(record => record.payload),
    };
    let encoded = JSON.stringify(body);
    while (Buffer.byteLength(encoded) > 4 * 1024 * 1024 && pending.length > 1) {
      pending = pending.slice(0, Math.ceil(pending.length / 2));
      body.records = pending.map(record => record.payload);
      encoded = JSON.stringify(body);
    }
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error("a queued record exceeds the 4 MiB request limit");
    delivery = outbox.saveDelivery(pending.map(record => record.id), encoded, pending[0]!.attempts);
  }
  let permanent = false;
  try {
    const response = await fetch(`${credentials.apiBase}/v1/ingest/batches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.deviceToken}`,
        "content-type": "application/json",
      },
      body: delivery.body,
      signal: AbortSignal.timeout(25_000),
      redirect: "error",
    });
    permanent = response.status === 400 || response.status === 422;
    if (!response.ok) throw new Error(`upload failed with HTTP ${response.status}; queued data is retained and will retry with backoff`);
    const receipt = await response.json() as IngestReceipt;
    const expected = JSON.parse(delivery.body) as { batch_id: string };
    if (receipt.batch_id !== expected.batch_id
      || ![receipt.accepted, receipt.duplicate, receipt.rejected].every(n => Number.isInteger(n) && n >= 0)
      || receipt.accepted + receipt.duplicate + receipt.rejected !== delivery.ids.length) {
      throw new Error("invalid upload receipt; no records acknowledged");
    }
    if (receipt.rejected !== 0) {
      const results = receipt.record_results;
      if (!results || results.length !== delivery.ids.length
        || new Set(results.map(r => r.index)).size !== results.length
        || results.some(r => !Number.isInteger(r.index) || r.index < 0 || r.index >= delivery!.ids.length
          || !["accepted", "duplicate", "rejected"].includes(r.status))
        || results.filter(r => r.status === 'rejected').length !== receipt.rejected
        || results.filter(r => r.status === 'accepted').length !== receipt.accepted
        || results.filter(r => r.status === 'duplicate').length !== receipt.duplicate) {
        throw new Error("partial receipt has no complete per-record results; queued records retained");
      }
      outbox.finishDelivery(
        results.filter(r => r.status !== "rejected").map(r => delivery!.ids[r.index]!),
        results.filter(r => r.status === "rejected").map(r => delivery!.ids[r.index]!),
      );
    } else outbox.finishDelivery(delivery.ids);
    return receipt;
  } catch (error) {
    outbox.deferDelivery(delivery, permanent);
    throw error;
  }
}
