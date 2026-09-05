import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanJsonl } from "../dist/scanner.js";

test("scanner retains bounded prefix/suffix and drops oversized content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linus-scanner-"));
  try {
    const path = join(directory, "events.jsonl");
    await writeFile(path, Buffer.concat([
      Buffer.from("abcdef"),
      Buffer.alloc(100, "x"),
      Buffer.from("status\nshort\n"),
    ]));
    const records = [];
    for await (const record of scanJsonl(path, {
      chunkSize: 9,
      prefixLimit: 6,
      suffixLimit: 8,
      contentLimit: 32,
    })) records.push(record);

    assert.equal(records.length, 2);
    assert.equal(records[0].prefix.toString(), "abcdef");
    assert.equal(records[0].suffix.toString(), "xxstatus");
    assert.equal(records[0].byteLength, 112);
    assert.equal(records[0].content, null);
    assert.equal(records[0].truncated, true);
    assert.equal(records[1].content.toString(), "short");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanner reports an incomplete trailing record without advancing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linus-scanner-"));
  try {
    const path = join(directory, "events.jsonl");
    await writeFile(path, '{"type":"user"}\n{"type":"partial"}');
    const records = [];
    for await (const record of scanJsonl(path, { chunkSize: 7 })) records.push(record);
    assert.equal(records[0].complete, true);
    assert.equal(records[1].complete, false);
    assert.equal(records[1].startOffset, records[0].endOffset);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
