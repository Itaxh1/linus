import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Outbox } from '../dist/outbox.js';
import { flushOutbox } from '../dist/uploader.js';

const credentials = { apiBase: 'https://api.example.test', deviceToken: 'test-token' };
async function withQueue(run, count = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'linus-delivery-'));
  const path = join(directory, 'queue.sqlite3');
  let queue = new Outbox(path);
  const originalFetch = globalThis.fetch;
  for (let i = 0; i < count; i++) queue.commitRecord({
    sourceFileId: 'file', identityId: 'identity', generation: 0, path: '/test.jsonl',
    source: 'codex', size: 1000, nextOffset: 50 * (i + 1), nextSequence: i + 1,
    payloadHash: 'a'.repeat(64), payloads: [{ itemIndex: 0, payload: { sequence: i } }],
  });
  try {
    await run(() => queue, () => { queue.close(); queue = new Outbox(path); });
  } finally {
    globalThis.fetch = originalFetch; queue.close(); await rm(directory, { recursive: true, force: true });
  }
}

test('503 retries back off and preserve the exact batch across restart', async () => withQueue(async (get, restart) => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(init.body); return new Response('', { status: 503 }); };
  await assert.rejects(flushOutbox(get(), credentials), /HTTP 503/);
  assert.equal(get().count(), 2);
  assert.equal(get().delivery().attempts, 1);
  assert.ok(get().delivery().availableAt > Date.now());
  assert.equal(await flushOutbox(get(), credentials), null);
  assert.equal(bodies.length, 1);
  restart();
  get().database.exec('UPDATE delivery SET available_at = 0');
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body);
    const body = JSON.parse(init.body);
    return Response.json({ batch_id: body.batch_id, accepted: 2, duplicate: 0, rejected: 0 });
  };
  await flushOutbox(get(), credentials);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(get().count(), 0);
  assert.equal(get().delivery(), null);
}));

test('revoked credentials are fatal but retain the queue and retry receipt', async () => withQueue(async get => {
  globalThis.fetch = async () => new Response('', { status: 401 });
  await assert.rejects(flushOutbox(get(), credentials), error => error.fatal === true && /Queued data is kept/.test(error.message));
  assert.equal(get().count(), 2);
  assert.ok(get().delivery());
}));

test('partial receipts acknowledge only identified successes and retain rejected data', async () => withQueue(async get => {
  globalThis.fetch = async (_url, init) => Response.json({
    batch_id: JSON.parse(init.body).batch_id, accepted: 1, duplicate: 0, rejected: 1,
    record_results: [{ index: 0, status: 'accepted' }, { index: 1, status: 'rejected' }],
  });
  await flushOutbox(get(), credentials);
  assert.equal(get().count(), 1);
  assert.equal(get().quarantined(), 1);
  assert.equal(get().activeCount(), 0);
  assert.equal(get().pending().length, 0);
}));

test('schema-rejected single-record retries retain increasing backoff', async () => withQueue(async get => {
  globalThis.fetch = async () => new Response('', { status: 422 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    get().database.exec("UPDATE outbox SET available_at = '2000-01-01T00:00:00Z'");
    const started = Date.now();
    await assert.rejects(flushOutbox(get(), credentials), /422/);
    const row = get().database.prepare('SELECT attempts, available_at FROM outbox').get();
    assert.equal(row.attempts, attempt);
    assert.ok(Date.parse(row.available_at) - started >= 1_500 * 2 ** (attempt - 1));
  }
}, 1));

test('retry jitter never exceeds the five-minute cap', async () => withQueue(async get => {
  globalThis.fetch = async () => { throw new Error('connection reset'); };
  await assert.rejects(flushOutbox(get(), credentials), /connection reset/);
  get().database.exec('UPDATE delivery SET attempts = 20, available_at = 0');
  await assert.rejects(flushOutbox(get(), credentials), /connection reset/);
  assert.ok(get().delivery().availableAt - Date.now() <= 300_000);
  assert.equal(get().count(), 2);
}));

test('an ambiguous or mismatched receipt never deletes queued records', async () => withQueue(async get => {
  globalThis.fetch = async (_url, init) => Response.json({
    batch_id: JSON.parse(init.body).batch_id, accepted: 1, duplicate: 0, rejected: 1,
  });
  await assert.rejects(flushOutbox(get(), credentials), /partial receipt/);
  assert.equal(get().count(), 2);
  get().database.exec('UPDATE delivery SET available_at = 0');
  globalThis.fetch = async () => Response.json({ batch_id: 'wrong', accepted: 2, duplicate: 0, rejected: 0 });
  await assert.rejects(flushOutbox(get(), credentials), /invalid upload receipt/);
  assert.equal(get().count(), 2);
}));

test('schema-rejected records are isolated individually, without trapping valid rows', async () => withQueue(async get => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (body.records.length > 1 || body.records[0].sequence === 0) return new Response('', { status: 422 });
    return Response.json({ batch_id: body.batch_id, accepted: 1, duplicate: 0, rejected: 0 });
  };
  for (let i = 0; i < 5; i++) {
    get().database.exec("UPDATE outbox SET available_at = '2000-01-01T00:00:00Z'");
    await assert.rejects(flushOutbox(get(), credentials), /422/);
  }
  get().database.exec("UPDATE outbox SET available_at = '2000-01-01T00:00:00Z'");
  await flushOutbox(get(), credentials);
  assert.equal(calls, 6);
  assert.equal(get().quarantined(), 1);
  assert.equal(get().count(), 1);
}));
