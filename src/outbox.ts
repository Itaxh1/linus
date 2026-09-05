import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Checkpoint {
  byteOffset: number;
  nextSequence: number;
}

export interface ResolvedSourceFile extends Checkpoint {
  sourceFileId: string;
  generation: number;
}

export interface PendingRecord {
  id: number;
  attempts: number;
  payload: Record<string, unknown>;
}

export interface Delivery {
  ids: number[];
  body: string;
  attempts: number;
  availableAt: number;
}

export class Outbox {
  readonly database: DatabaseSync;

  constructor(path: string) {
    const configuredMb = Number(process.env.LINUS_MAX_QUEUE_MB || 256);
    if (!Number.isFinite(configuredMb) || configuredMb < 8) throw new Error("LINUS_MAX_QUEUE_MB must be at least 8");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS source_files (
        source_file_id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        path TEXT NOT NULL,
        source TEXT NOT NULL,
        size INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        next_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        source_file_id TEXT NOT NULL,
        source_sequence INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(kind, source_file_id, source_sequence, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS device_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_batch_sequence INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO device_state(singleton, next_batch_sequence) VALUES (1, 1);
      CREATE TABLE IF NOT EXISTS delivery (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        ids TEXT NOT NULL, body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collector_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_source_identity TEXT NOT NULL
      ) STRICT;
    `);
    const columns = this.database.prepare("PRAGMA table_info(outbox)").all();
    if (!columns.some(column => column.name === "quarantined")) {
      this.database.exec("ALTER TABLE outbox ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0");
    }
    const pageSize = Number(this.database.prepare("PRAGMA page_size").get()!.page_size);
    this.database.exec(`PRAGMA max_page_count = ${Math.floor(configuredMb * 1024 * 1024 / pageSize)}`);
  }

  canCollect(): boolean {
    const pages = Number(this.database.prepare("PRAGMA page_count").get()!.page_count);
    const free = Number(this.database.prepare("PRAGMA freelist_count").get()!.freelist_count);
    const maximum = Number(this.database.prepare("PRAGMA max_page_count").get()!.max_page_count);
    const pageSize = Number(this.database.prepare("PRAGMA page_size").get()!.page_size);
    // Reserve space for one bounded record, the in-flight batch, and indexes.
    return (maximum - pages + free) * pageSize > 6 * 1024 * 1024;
  }

  delivery(): Delivery | null {
    const row = this.database.prepare("SELECT ids, body, attempts, available_at FROM delivery WHERE singleton = 1").get();
    return row ? { ids: JSON.parse(String(row.ids)), body: String(row.body), attempts: Number(row.attempts), availableAt: Number(row.available_at) } : null;
  }

  saveDelivery(ids: number[], body: string, attempts = 0): Delivery {
    this.database.prepare("INSERT INTO delivery(singleton, ids, body, attempts) VALUES (1, ?, ?, ?)").run(JSON.stringify(ids), body, attempts);
    return { ids, body, attempts, availableAt: 0 };
  }

  deferDelivery(delivery: Delivery, permanent = false): void {
    const delay = Math.min(300_000, 2_000 * 2 ** Math.min(delivery.attempts, 8));
    const availableAt = Date.now() + Math.min(300_000, Math.round(delay * (0.75 + Math.random() * 0.5)));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of delivery.ids) {
        this.database.prepare("UPDATE outbox SET attempts = attempts + 1, available_at = ? WHERE id = ?")
          .run(new Date(availableAt).toISOString(), id);
      }
      if (permanent) {
        // A schema-rejected batch wasn't committed. Try individual records next;
        // only confirmed single-record failures can be quarantined.
        if (delivery.ids.length === 1) {
          this.database.prepare("UPDATE outbox SET quarantined = 1 WHERE id = ? AND attempts >= 5").run(delivery.ids[0]!);
        }
        this.database.exec("DELETE FROM delivery");
      } else {
        this.database.prepare("UPDATE delivery SET attempts = attempts + 1, available_at = ? WHERE singleton = 1").run(availableAt);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  finishDelivery(ids: number[], rejected: number[] = []): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) this.database.prepare("DELETE FROM outbox WHERE id = ?").run(id);
      for (const id of rejected) this.database.prepare("UPDATE outbox SET quarantined = 1 WHERE id = ?").run(id);
      this.database.exec("DELETE FROM delivery");
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  quarantined(): number {
    return Number(this.database.prepare("SELECT count(*) AS n FROM outbox WHERE quarantined = 1").get()!.n);
  }

  activeCount(): number {
    return Number(this.database.prepare("SELECT count(*) AS n FROM outbox WHERE quarantined = 0").get()!.n);
  }

  lastScannedFile(): string | null {
    const row = this.database.prepare("SELECT last_source_identity FROM collector_state WHERE singleton = 1").get();
    return row ? String(row.last_source_identity) : null;
  }

  markScannedFile(identityId: string): void {
    this.database.prepare(`
      INSERT INTO collector_state(singleton, last_source_identity) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET last_source_identity = excluded.last_source_identity
    `).run(identityId);
  }

  checkpoint(sourceFileId: string): Checkpoint {
    const row = this.database.prepare(
      "SELECT byte_offset, next_sequence FROM source_files WHERE source_file_id = ?",
    ).get(sourceFileId) as { byte_offset: number; next_sequence: number } | undefined;
    return row
      ? { byteOffset: row.byte_offset, nextSequence: row.next_sequence }
      : { byteOffset: 0, nextSequence: 0 };
  }

  resolveSourceFile(input: {
    identityId: string;
    path: string;
    source: string;
    size: number;
  }): ResolvedSourceFile {
    const previous = this.database.prepare(`
      SELECT source_file_id, identity_id, generation, byte_offset, next_sequence
      FROM source_files
      WHERE path = ? AND source = ?
      ORDER BY updated_at DESC, generation DESC
      LIMIT 1
    `).get(input.path, input.source) as {
      source_file_id: string;
      identity_id: string;
      generation: number;
      byte_offset: number;
      next_sequence: number;
    } | undefined;

    if (
      previous
      && previous.identity_id === input.identityId
      && input.size >= previous.byte_offset
    ) {
      return {
        sourceFileId: previous.source_file_id,
        generation: previous.generation,
        byteOffset: previous.byte_offset,
        nextSequence: previous.next_sequence,
      };
    }

    const generation = previous && previous.identity_id === input.identityId
      ? previous.generation + 1
      : 0;
    const sourceFileId = createGenerationId(input.identityId, generation);
    this.database.prepare(`
      INSERT OR IGNORE INTO source_files(
        source_file_id, identity_id, generation, path, source,
        size, byte_offset, next_sequence, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(
      sourceFileId,
      input.identityId,
      generation,
      input.path,
      input.source,
      input.size,
      new Date().toISOString(),
    );
    return { sourceFileId, generation, byteOffset: 0, nextSequence: 0 };
  }

  commitRecord(input: {
    sourceFileId: string;
    identityId: string;
    generation: number;
    path: string;
    source: string;
    size: number;
    nextOffset: number;
    nextSequence: number;
    payloadHash: string;
    payloads: Array<{ itemIndex: number; payload: Record<string, unknown> }>;
  }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO source_files(
          source_file_id, identity_id, generation, path, source,
          size, byte_offset, next_sequence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_file_id) DO UPDATE SET
          size = excluded.size,
          byte_offset = excluded.byte_offset,
          next_sequence = excluded.next_sequence,
          updated_at = excluded.updated_at
      `).run(
        input.sourceFileId,
        input.identityId,
        input.generation,
        input.path,
        input.source,
        input.size,
        input.nextOffset,
        input.nextSequence,
        new Date().toISOString(),
      );
      if (input.payloads.length > 0) {
        const now = new Date().toISOString();
        const insert = this.database.prepare(`
          INSERT OR IGNORE INTO outbox(
            kind, source_file_id, source_sequence, revision,
            payload, payload_hash, available_at, created_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
        `);
        for (const item of input.payloads) {
          insert.run(
            `event:${item.itemIndex}`,
            input.sourceFileId,
            input.nextSequence - 1,
            JSON.stringify(item.payload),
            input.payloadHash,
            now,
            now,
          );
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  pending(limit = 500): PendingRecord[] {
    const rows = this.database.prepare(`
      SELECT id, payload, attempts FROM outbox
      WHERE available_at <= ? AND quarantined = 0
      ORDER BY id
      LIMIT ?
    `).all(new Date().toISOString(), limit) as Array<{ id: number; payload: string; attempts: number }>;
    return rows.map((row) => ({ id: row.id, attempts: row.attempts, payload: JSON.parse(row.payload) }));
  }

  acknowledge(ids: number[]): void {
    if (ids.length === 0) return;
    const remove = this.database.prepare("DELETE FROM outbox WHERE id = ?");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) remove.run(id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  nextBatchSequence(): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT next_batch_sequence FROM device_state WHERE singleton = 1",
      ).get() as { next_batch_sequence: number };
      this.database.prepare(
        "UPDATE device_state SET next_batch_sequence = ? WHERE singleton = 1",
      ).run(row.next_batch_sequence + 1);
      this.database.exec("COMMIT");
      return row.next_batch_sequence;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  count(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM outbox").get() as { count: number };
    return row.count;
  }

  close(): void {
    this.database.close();
  }
}

function createGenerationId(identityId: string, generation: number): string {
  return createHash("sha256").update(`${identityId}:${generation}`).digest("hex");
}
