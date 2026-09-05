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
  payload: Record<string, unknown>;
}

export class Outbox {
  readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
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
    `);
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
      SELECT id, payload FROM outbox
      WHERE available_at <= ?
      ORDER BY id
      LIMIT ?
    `).all(new Date().toISOString(), limit) as Array<{ id: number; payload: string }>;
    return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.payload) }));
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
