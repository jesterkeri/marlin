import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rm, appendFile, mkdir } from 'node:fs/promises';
import { WriteBuffer, type WalEvent } from '../src/db/writeBuffer.js';

const walPath = (): string => join(tmpdir(), `marlin-wal-${randomUUID()}.jsonl`);

test('happy path: events go to the sink, WAL is never written', async () => {
  const path = walPath();
  const sink: WalEvent[] = [];
  const buf = new WriteBuffer({ walPath: path, writeFn: async (e) => void sink.push(e) });
  buf.enqueue('lifecycle', 'a#1#submitted', { x: 1 });
  buf.enqueue('lifecycle', 'a#1#processed', { x: 2 });
  await buf.flush();
  assert.equal(sink.length, 2);
  await assert.rejects(readFile(path, 'utf8')); // no WAL file created
});

test('sink failure → events land in WAL in append order (submission never blocks)', async () => {
  const path = walPath();
  const buf = new WriteBuffer({ walPath: path, writeFn: async () => { throw new Error('pg down'); } });
  buf.enqueue('failure', 'k1', { a: 1 });
  buf.enqueue('failure', 'k2', { a: 2 });
  await buf.flush();
  const keys = (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).key);
  assert.deepEqual(keys, ['k1', 'k2']);
  await rm(path, { force: true });
});

test('replayWal drains to the sink and truncates on full success', async () => {
  const path = walPath();
  let up = false;
  const sink: WalEvent[] = [];
  const buf = new WriteBuffer({
    walPath: path,
    writeFn: async (e) => {
      if (!up) throw new Error('down');
      sink.push(e);
    },
  });
  buf.enqueue('x', 'k1', {});
  buf.enqueue('x', 'k2', {});
  await buf.flush(); // both fail → WAL
  up = true;
  const r = await buf.replayWal();
  assert.deepEqual([r.replayed, r.remaining], [2, 0]);
  assert.deepEqual(sink.map((e) => e.key), ['k1', 'k2']); // append order preserved
  assert.equal(await readFile(path, 'utf8'), ''); // truncated
  await rm(path, { force: true });
});

test('replayWal keeps still-failing lines for the next recovery', async () => {
  const path = walPath();
  // seed the WAL with a down sink
  const down = new WriteBuffer({ walPath: path, writeFn: async () => { throw new Error('down'); } });
  down.enqueue('x', 'ok', { bad: false });
  down.enqueue('x', 'bad', { bad: true });
  await down.flush();
  // replay with a sink that only fails the "bad" one
  const buf = new WriteBuffer({
    walPath: path,
    writeFn: async (e) => {
      if ((e.payload as { bad: boolean }).bad) throw new Error('still bad');
    },
  });
  const r = await buf.replayWal();
  assert.deepEqual([r.replayed, r.remaining], [1, 1]);
  const left = (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(left.length, 1);
  assert.equal(left[0].key, 'bad');
  await rm(path, { force: true });
});

test('replayWal preserves corrupt lines (no silent drop)', async () => {
  const path = walPath();
  await appendFile(path, `this is not json\n${JSON.stringify({ seq: 1, kind: 'x', key: 'ok', payload: {} })}\n`, 'utf8');
  const got: string[] = [];
  const buf = new WriteBuffer({ walPath: path, writeFn: async (e) => void got.push(e.key) });
  const r = await buf.replayWal();
  assert.equal(r.replayed, 1);
  assert.equal(r.corrupt, 1);
  assert.equal(r.remaining, 1); // corrupt line preserved, not dropped
  const left = (await readFile(path, 'utf8')).trim().split('\n');
  assert.deepEqual(left, ['this is not json']);
  await rm(path, { force: true });
});

test('sink+WAL both fail → onFatal, flush() REJECTS, hasPendingFatal (no silent settle on shutdown)', async () => {
  // Point the WAL at a directory so appendFile throws EISDIR — both sinks fail.
  const dir = join(tmpdir(), `marlin-wal-dir-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  let fatal = 0;
  const buf = new WriteBuffer({
    walPath: dir,
    writeFn: async () => {
      throw new Error('pg down');
    },
    onFatal: () => void fatal++,
  });
  buf.enqueue('x', 'k', {});
  await assert.rejects(buf.flush(), /flush incomplete/); // graceful shutdown cannot think it settled
  assert.ok(fatal >= 1);
  assert.equal(buf.hasPendingFatal(), true);
  await rm(dir, { recursive: true, force: true });
});

test('flush() RETRIES RAM-only events after the sink recovers (no new enqueue needed)', async () => {
  const dir = join(tmpdir(), `marlin-wal-dir-${randomUUID()}`);
  await mkdir(dir, { recursive: true }); // WAL append always fails (it's a dir) → fatal while sink is down
  let up = false;
  const got: string[] = [];
  const buf = new WriteBuffer({
    walPath: dir,
    writeFn: async (e) => {
      if (!up) throw new Error('down');
      got.push(e.key);
    },
  });
  buf.enqueue('x', 'k', {});
  await assert.rejects(buf.flush()); // sink down + WAL unusable → fatal, stuck in RAM
  assert.equal(buf.hasPendingFatal(), true);
  up = true; // sink recovers
  await buf.flush(); // actively retries the stuck event — resolves now
  assert.deepEqual(got, ['k']);
  assert.equal(buf.hasPendingFatal(), false);
  await rm(dir, { recursive: true, force: true });
});

test('overflow callback fires past maxWalBytes (advisory, no data loss)', async () => {
  const path = walPath();
  let overflow = 0;
  const buf = new WriteBuffer({
    walPath: path,
    maxWalBytes: 10,
    onOverflow: () => void overflow++,
    writeFn: async () => { throw new Error('down'); },
  });
  buf.enqueue('x', 'k', { padding: 'comfortably more than ten bytes' });
  await buf.flush();
  assert.ok(overflow >= 1);
  await rm(path, { force: true });
});
