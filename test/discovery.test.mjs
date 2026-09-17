import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverTranscripts } from "../dist/discovery.js";

test("source identity stays stable across appends", async () => {
  const home = await mkdtemp(join(tmpdir(), "linus-discovery-"));
  try {
    const root = join(home, ".codex", "sessions");
    const path = join(root, "session.jsonl");
    await mkdir(root, { recursive: true });
    await writeFile(path, '{"type":"session_meta"}');
    assert.equal((await discoverTranscripts("install-1", home)).length, 0);

    await appendFile(path, "\n");
    const first = await discoverTranscripts("install-1", home);
    await appendFile(path, '{"type":"user"}\n');
    const second = await discoverTranscripts("install-1", home);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].identityId, second[0].identityId);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("newest transcript files are imported first", async () => {
  const home = await mkdtemp(join(tmpdir(), "linus-discovery-order-"));
  try {
    const root = join(home, ".codex", "sessions");
    const older = join(root, "older.jsonl");
    const newer = join(root, "newer.jsonl");
    await mkdir(root, { recursive: true });
    await writeFile(older, '{"type":"session_meta"}\n');
    await writeFile(newer, '{"type":"session_meta"}\n');
    await utimes(older, new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(newer, new Date("2026-09-04"), new Date("2026-09-04"));

    const files = await discoverTranscripts("install-1", home);
    assert.equal(files[0].path, newer);
    assert.equal(files[1].path, older);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('native conversation identity survives reinstall while file checkpoints remain installation scoped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'linus-native-'));
  try {
    const root = join(home, '.codex', 'sessions');
    await mkdir(root, { recursive: true });
    const id = '0194e18c-4042-7000-8123-123456789abc';
    await writeFile(join(root, 'session.jsonl'), JSON.stringify({timestamp:'2026-09-16T12:00:00Z',type:'session_meta',payload:{id, instructions:'x'.repeat(10000)}}) + '\n');
    const [a] = await discoverTranscripts('old-install', home);
    const [b] = await discoverTranscripts('new-install', home);
    assert.equal(a.nativeSessionId, id);
    assert.equal(b.nativeSessionId, id);
    assert.notEqual(a.identityId, b.identityId);
    await writeFile(join(root, 'prompt.jsonl'), JSON.stringify({timestamp:'2026-09-16T12:00:00Z',type:'response_item',payload:{id,role:'user'}}) + '\n');
    const prompt = (await discoverTranscripts('old-install', home)).find(f => f.path.endsWith('prompt.jsonl'));
    assert.equal(prompt.nativeSessionId, undefined);
  } finally {
    await rm(home, {recursive:true, force:true});
  }
});
