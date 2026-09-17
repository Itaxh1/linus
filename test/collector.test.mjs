import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectOnce } from '../dist/collector.js';
import { Outbox } from '../dist/outbox.js';

const credentials = { apiBase: 'https://api.example.test', deviceToken: 'fixture-token', installationId: 'fixture-install' };
const line = JSON.stringify({ timestamp: '2026-09-04T12:00:00Z', type: 'user', sessionId: 'fixture-session', message: { role: 'user', content: 'Check the fixture.' } }) + '\n';

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'linus-collector-'));
  const root = join(directory, '.claude', 'projects', 'fixture');
  const data = join(directory, 'state');
  await mkdir(root, { recursive: true });
  const originalFetch = globalThis.fetch;
  try { await run({ directory, root, data }); }
  finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
}

test('one upload per cycle, with older files reached across collector restarts', async () => withFixture(async ({ directory, root, data }) => {
  for (let i = 0; i < 14; i++) await writeFile(join(root, `session-${i}.jsonl`), line.repeat(501));
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const batch = JSON.parse(init.body);
    assert.ok(batch.records.length <= 500);
    assert.ok(Buffer.byteLength(init.body) <= 4 * 1024 * 1024);
    return Response.json({ batch_id: batch.batch_id, accepted: batch.records.length, duplicate: 0, rejected: 0 });
  };
  let first = true;
  let reached = 0;
  for (let cycle = 0; cycle < 20 && reached < 14; cycle++) {
    const before = requests;
    const result = await collectOnce(credentials, data, directory);
    assert.equal(requests - before, 1);
    assert.ok(result.records <= 5_000);
    assert.ok(result.bytes > 0);
    const queue = new Outbox(join(data, 'linus.sqlite3'));
    try {
      reached = Number(queue.database.prepare('SELECT count(*) AS n FROM source_files WHERE next_sequence > 0').get().n);
      assert.ok(queue.lastScannedFile());
      if (first) assert.ok(reached < 14, 'fixture must span multiple cycles');
    } finally { queue.close(); }
    first = false;
  }
  assert.equal(reached, 14, 'older files must not wait for newer files to finish');
}));

test('an incomplete tail is retried after append, without duplicate uploads', async () => withFixture(async ({ directory, root, data }) => {
  const path = join(root, 'session.jsonl');
  await writeFile(path, line + line.slice(0, -1));
  const sequences = [];
  globalThis.fetch = async (_url, init) => {
    const batch = JSON.parse(init.body);
    sequences.push(...batch.records.map(record => record.sequence));
    return Response.json({ batch_id: batch.batch_id, accepted: batch.records.length, duplicate: 0, rejected: 0 });
  };
  assert.equal((await collectOnce(credentials, data, directory)).records, 1);
  assert.equal((await collectOnce(credentials, data, directory)).records, 0);
  await writeFile(path, line.repeat(2));
  assert.equal((await collectOnce(credentials, data, directory)).records, 1);
  assert.deepEqual(sequences, [0, 1]);
}));

test('a failed upload retains data and does not retry once per file or on restart before backoff', async () => withFixture(async ({ directory, root, data }) => {
  for (let i = 0; i < 3; i++) await writeFile(join(root, `session-${i}.jsonl`), line);
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('', { status: 503 }); };
  const result = await collectOnce(credentials, data, directory);
  assert.equal(result.pending, 3);
  assert.match(result.uploadError, /503/);
  assert.equal(requests, 1);
  const restarted = await collectOnce(credentials, data, directory);
  assert.equal(restarted.records, 0);
  assert.equal(restarted.pending, 3);
  assert.equal(requests, 1);
}));

test('native Codex identity is transmitted on every event, including resumed appends', async () => withFixture(async ({ directory, data }) => {
  const root=join(directory,'.codex','sessions'); await mkdir(root,{recursive:true});
  const path=join(root,'session.jsonl');
  const id='0194e18c-4042-7000-8123-123456789abc';
  const meta=JSON.stringify({timestamp:'2026-09-16T12:00:00Z',type:'session_meta',payload:{id}})+'\n';
  const prompt=JSON.stringify({timestamp:'2026-09-16T12:01:00Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Fix caching'}]}})+'\n';
  await writeFile(path,meta+prompt);
  const uploaded=[];
  globalThis.fetch=async (_url,init) => {
    const batch=JSON.parse(init.body); uploaded.push(...batch.records);
    return Response.json({batch_id:batch.batch_id,accepted:batch.records.length,duplicate:0,rejected:0});
  };
  await collectOnce(credentials,data,directory);
  assert.ok(uploaded.length>=2);
  assert.ok(uploaded.every(r=>r.event.native_session_id===id));
  uploaded.length=0;
  await writeFile(path,meta+prompt+prompt);
  await collectOnce(credentials,data,directory);
  assert.equal(uploaded.length,1);
  assert.equal(uploaded[0].event.native_session_id,id);
  assert.equal(uploaded[0].sequence,2);
}));
