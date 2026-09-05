import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
