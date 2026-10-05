import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIResponse, BrowserContext } from 'playwright';
import { BrowserBackend } from '../src/browser.js';
import { config } from '../src/config.js';
import { resourceFile } from '../src/parser.js';
import { MoodleError, type RemoteFile, type StoredFile, type DownloadResult } from '../src/model.js';

const file = resourceFile({ courseId: 101, moduleId: 201, title: 'ODE1', type: 'file', url: 'https://moodle.nottingham.ac.uk/mod/resource/view.php?id=201' });
function response(status: number, headers: Record<string, string>, bytes: string | Error): APIResponse {
  return { status: () => status, url: () => file.url, headers: () => headers, body: async () => { if (bytes instanceof Error) throw bytes; return Buffer.from(bytes); }, dispose: async () => {} } as unknown as APIResponse;
}
function harness(get: (url: string) => Promise<APIResponse>) {
  const b = new BrowserBackend({ ...config(), setupConfirmed: true, courses: [{ id: 101, name: 'Example course' }], requestIntervalMs: 0 });
  const internals = b as unknown as { session: () => Promise<BrowserContext>; downloadOnce: (f: RemoteFile, d: string, previous?: StoredFile, force?: boolean) => Promise<DownloadResult> };
  internals.session = async () => ({ request: { get } }) as unknown as BrowserContext;
  return { b, internals };
}
test('cross-domain and login redirects stop before credentials can reach a second destination', async () => {
  for (const location of ['https://external.example/file', '/login/index.php']) {
    const calls: string[] = [];
    const { internals } = harness(async url => { calls.push(url); return response(302, { location }, ''); });
    await assert.rejects(internals.downloadOnce(file, '/unused'), location.startsWith('https://external') ? /外部域名/ : /重新认证/);
    assert.equal(calls.length, 1);
  }
});
test('partial responses never commit a staging file and retry succeeds', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodle-download-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const { b, internals } = harness(async () => {
    calls++; return calls === 1 ? response(200, { 'content-type': 'application/pdf', 'content-length': '9' }, 'part') : response(200, { 'content-type': 'application/pdf', 'content-length': '9' }, '%PDF-test');
  });
  await assert.rejects(internals.downloadOnce(file, dir), /网络/); assert.deepEqual(await readdir(dir), []);
  calls = 0; const result = await b.download(file, dir); assert.equal(calls, 2); assert.equal(result.kind, 'downloaded'); assert.equal(result.attempts, 2);
  assert.equal(result.bytes, 9); assert.equal((await readdir(dir)).length, 1);
});
test('permission, disappearance and oversized resources return clear failures without files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodle-status-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [status, headers, expected] of [[403, {}, /权限/], [404, {}, /不存在/], [200, { 'content-length': String(101 * 1024 * 1024) }, /大小/]] as const) {
    const { internals } = harness(async () => response(status, headers, 'x'));
    await assert.rejects(internals.downloadOnce(file, dir), expected);
  }
  assert.deepEqual(await readdir(dir), []);
});
test('a published Moodle HTML lecture is saved as data without executing it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodle-html-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const r = response(200, { 'content-type': 'text/html' }, '<html><script>throw new Error("must not execute")</script><p>Lecture</p></html>');
  r.url = () => 'https://moodle.nottingham.ac.uk/pluginfile.php/12917344/mod_resource/content/5/lecture.html';
  const { internals } = harness(async () => r);
  const result = await internals.downloadOnce(file, dir);
  assert.equal(result.filename, 'lecture.html'); assert.equal(result.kind, 'downloaded');
});

test('a transient parse failure retries and saves only the successful download', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodle-parse-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const { b } = harness(async () => {
    calls++;
    return response(200, { 'content-type': 'application/pdf' }, calls === 1 ? '' : '%PDF-test');
  });
  const result = await b.download(file, dir);
  assert.equal(calls, 2); assert.equal(result.kind, 'downloaded'); assert.equal(result.attempts, 2);
  assert.equal((await readdir(dir)).length, 1);
});

test('persistent parse failures stop after three attempts without saving a file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodle-parse-limit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const { b } = harness(async () => { calls++; return response(200, { 'content-type': 'application/pdf' }, ''); });
  await assert.rejects(b.download(file, dir), (e: unknown) => e instanceof MoodleError && e.code === 'PARSE_FAILED' && e.attempts === 3 && e.stage === 'download' && e.automaticRetryExhausted === true);
  assert.equal(calls, 3); assert.deepEqual(await readdir(dir), []);
});

test('authentication, permission and rate limit failures are not retried', async () => {
  for (const [status, code] of [[401, 'NEEDS_LOGIN'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED']] as const) {
    let calls = 0;
    const { b } = harness(async () => { calls++; return response(status, {}, ''); });
    await assert.rejects(b.download(file, '/unused'), (e: unknown) => e instanceof MoodleError && e.code === code);
    assert.equal(calls, 1);
  }
});
