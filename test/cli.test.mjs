import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { saveCredentials } from '../dist/config.js';

const run = promisify(execFile);
test('re-pasting a consumed claim resumes; failed re-pairing never reassigns an existing queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linus-cli-test-'));
  const state = join(directory, 'state');
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url !== '/v1/ingest/batches') { res.writeHead(400).end(); return; }
    const batch = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ batch_id: batch.batch_id, accepted: batch.records.length, duplicate: 0, rejected: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  try {
    const root = join(directory, 'transcripts/.claude/projects/fixture');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'test.jsonl'), JSON.stringify({ timestamp: '2026-09-04T12:00:00Z', type: 'user',
      sessionId: 'fixture', message: { role: 'user', content: 'Synthetic test only' } }) + '\n');
    await saveCredentials({ apiBase: api, deviceId: 'fixture', deviceToken: 'private-fixture-token' }, state);
    const original = await readFile(join(state, 'credentials.json'), 'utf8');
    const env = { ...process.env, LINUS_DATA_DIR: state, LINUS_TEST_TRANSCRIPTS: join(directory, 'transcripts') };
    const base = ['--import', resolve('test/fixtures/isolated-home.mjs'), resolve('dist/cli.js')];
    const first = await run(process.execPath, [...base, '--claim', 'consumed-fixture-claim', '--api', api, '--once', '--verbose'], { env });
    assert.match(first.stdout, /Already connected/);
    assert.match(first.stdout, /uploaded 1/);
    assert.match(first.stdout, /pending 0/);
    assert.ok(!first.stdout.includes('private-fixture-token'));
    assert.deepEqual(requests, ['/v1/ingest/batches']);
    const second = await run(process.execPath, [...base, '--once', '--verbose'], { env });
    assert.match(second.stdout, /records 0/);
    await assert.rejects(run(process.execPath, [...base, '--claim', 'new-fixture-claim', '--api', 'https://different.example.test', '--once'], { env }),
      error => /fresh LINUS_DATA_DIR/.test(error.stderr));
    await assert.rejects(run(process.execPath, [...base, '--claim', 'new-fixture-claim', '--api', api, '--reconnect', '--once'], { env }),
      error => /fresh LINUS_DATA_DIR/.test(error.stderr));
    assert.equal(await readFile(join(state, 'credentials.json'), 'utf8'), original);
    assert.deepEqual(requests, ['/v1/ingest/batches']);
    await assert.rejects(run(process.execPath, [...base, '--reconnect'], { env }), error => /requires/.test(error.stderr));
    const fresh = { ...env, LINUS_DATA_DIR: join(directory, 'fresh') };
    await assert.rejects(run(process.execPath, [...base, '--claim', 'expired-fixture', '--api', api, '--once'], { env: fresh }),
      error => /Generate a fresh install command/.test(error.stderr));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
