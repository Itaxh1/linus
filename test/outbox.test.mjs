import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from 'node:sqlite';
import { Outbox } from "../dist/outbox.js";

test("checkpoint and outbox insert commit atomically and dedupe revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linus-outbox-"));
  const outbox = new Outbox(join(directory, "linus.sqlite3"));
  try {
    const input = {
      sourceFileId: "file-1",
      identityId: "identity-1",
      generation: 0,
      path: "/private/transcript.jsonl",
      source: "codex",
      size: 100,
      nextOffset: 50,
      nextSequence: 1,
      payloadHash: "a".repeat(64),
      payloads: [{ itemIndex: 0, payload: { event: { type: "user" } } }],
    };
    outbox.commitRecord(input);
    outbox.commitRecord(input);
    assert.deepEqual(outbox.checkpoint("file-1"), { byteOffset: 50, nextSequence: 1 });
    assert.equal(outbox.count(), 1);
    const pending = outbox.pending();
    outbox.acknowledge(pending.map((item) => item.id));
    assert.equal(outbox.count(), 0);
  } finally {
    outbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an in-place truncation creates a new source generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linus-outbox-"));
  const outbox = new Outbox(join(directory, "linus.sqlite3"));
  try {
    const first = outbox.resolveSourceFile({
      identityId: "identity-1",
      path: "/private/transcript.jsonl",
      source: "codex",
      size: 100,
    });
    outbox.commitRecord({
      sourceFileId: first.sourceFileId,
      identityId: "identity-1",
      generation: first.generation,
      path: "/private/transcript.jsonl",
      source: "codex",
      size: 100,
      nextOffset: 90,
      nextSequence: 10,
      payloadHash: "a".repeat(64),
      payloads: [],
    });
    const second = outbox.resolveSourceFile({
      identityId: "identity-1",
      path: "/private/transcript.jsonl",
      source: "codex",
      size: 20,
    });
    assert.notEqual(second.sourceFileId, first.sourceFileId);
    assert.equal(second.generation, 1);
    assert.equal(second.byteOffset, 0);
    assert.equal(second.nextSequence, 0);
  } finally {
    outbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the database budget pauses collection and recovers after acknowledged rows are removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linus-budget-'));
  const previous = process.env.LINUS_MAX_QUEUE_MB;
  process.env.LINUS_MAX_QUEUE_MB = '8';
  let queue;
  try {
    queue = new Outbox(join(directory, 'linus.sqlite3'));
    assert.equal(queue.canCollect(), true);
    let sequence = 0;
    while (queue.canCollect() && sequence < 100) {
      sequence++;
      queue.commitRecord({
        sourceFileId: 'file', identityId: 'identity', generation: 0, path: '/fixture.jsonl',
        source: 'codex', size: 100_000_000, nextOffset: sequence * 100_000, nextSequence: sequence,
        payloadHash: 'a'.repeat(64), payloads: [{ itemIndex: 0, payload: { preview: 'x'.repeat(100_000) } }],
      });
    }
    assert.ok(sequence < 100);
    assert.equal(queue.canCollect(), false);
    assert.equal(queue.checkpoint('file').nextSequence, sequence);
    queue.acknowledge(queue.pending(100).map(row => row.id));
    assert.equal(queue.canCollect(), true);
    assert.equal(queue.checkpoint('file').nextSequence, sequence);
  } finally {
    queue?.close();
    if (previous === undefined) delete process.env.LINUS_MAX_QUEUE_MB;
    else process.env.LINUS_MAX_QUEUE_MB = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('upgrading the previous queue schema preserves pending data and checkpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linus-upgrade-'));
  const path = join(directory, 'linus.sqlite3');
  let queue = new Outbox(path);
  try {
    queue.commitRecord({
      sourceFileId: 'file', identityId: 'identity', generation: 0, path: '/fixture.jsonl',
      source: 'codex', size: 100, nextOffset: 100, nextSequence: 1,
      payloadHash: 'a'.repeat(64), payloads: [{ itemIndex: 0, payload: { event: { type: 'user' } } }],
    });
    const before = queue.pending();
    assert.equal(queue.nextBatchSequence(), 1);
    queue.close();
    // Remove only the fields/tables added in 0.1.1 to model the 0.1.0 schema.
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec('ALTER TABLE outbox DROP COLUMN quarantined; DROP TABLE delivery; DROP TABLE collector_state;');
    } finally { legacy.close(); }
    queue = new Outbox(path);
    assert.deepEqual(queue.pending(), before);
    assert.deepEqual(queue.checkpoint('file'), { byteOffset: 100, nextSequence: 1 });
    assert.equal(queue.nextBatchSequence(), 2);
    assert.equal(queue.quarantined(), 0);
    assert.equal(queue.delivery(), null);
  } finally {
    queue.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an enqueue failure rolls back its checkpoint in the same transaction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linus-atomic-'));
  const queue = new Outbox(join(directory, 'linus.sqlite3'));
  try {
    const input = {
      sourceFileId: 'file', identityId: 'identity', generation: 0, path: '/fixture.jsonl',
      source: 'codex', size: 100, nextOffset: 50, nextSequence: 1,
      payloadHash: 'a'.repeat(64), payloads: [{ itemIndex: 0, payload: { event: { type: 'user' } } }],
    };
    queue.commitRecord(input);
    queue.database.exec("CREATE TRIGGER fail_enqueue BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END");
    assert.throws(() => queue.commitRecord({ ...input, nextOffset: 100, nextSequence: 2 }), /fixture disk failure/);
    assert.deepEqual(queue.checkpoint('file'), { byteOffset: 50, nextSequence: 1 });
    assert.equal(queue.count(), 1);
  } finally {
    queue.close();
    await rm(directory, { recursive: true, force: true });
  }
});
