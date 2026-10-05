import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config, type Config } from '../src/config.js';
import { parseCourses, parseResources, parseFolder, resourceFile } from '../src/parser.js';
import { inside, safeFilename, schoolUrl } from '../src/safety.js';
import { SyncEngine } from '../src/sync.js';
import { MoodleError, type Backend, type Resource, type RemoteFile, type StoredFile } from '../src/model.js';
import { dispositionFilename, responseCode } from '../src/browser.js';
import { MoodleService } from '../src/service.js';

const resource: Resource = { courseId: 101, moduleId: 201, title: 'ODE1', type: 'file', url: 'https://moodle.nottingham.ac.uk/mod/resource/view.php?id=201' };
class FakeBackend implements Backend {
  resources: Resource[] = [resource]; content = new Map<number, string>([[201, 'first PDF']]); failures = new Set<number>(); requests = 0; downloads = 0;
  async checkConnection() { return { connected: true, authenticated: true, needsLogin: false }; }
  async listCourses() { return [{ id: 101, name: 'ODE', selected: true }]; }
  async listResources() { return this.resources; }
  async listFiles(r: Resource) { return [resourceFile(r)]; }
  async download(file: RemoteFile, dir: string, previous?: StoredFile, force?: boolean) {
    this.requests++; if (this.failures.has(file.moduleId)) throw new MoodleError('NETWORK');
    const body = this.content.get(file.moduleId)!; const sha256 = createHash('sha256').update(body).digest('hex');
    if (!force && previous?.etag === sha256) return { kind: 'not_modified' as const };
    this.downloads++; await mkdir(dir, { recursive: true }); const stagingPath = join(dir, randomUUID() + '.part'); await writeFile(stagingPath, body);
    return { kind: 'downloaded' as const, stagingPath, filename: 'same.pdf', sha256, bytes: Buffer.byteLength(body), etag: sha256, mime: 'application/pdf' };
  }
  async close() {}
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'moodle-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cfg: Config = { ...config(), setupConfirmed: true, courses: [{ id: 101, name: 'Example course' }], dataDir: root, stateDir: join(root, 'state'), materialsDir: join(root, 'materials'), profileDir: join(root, 'profile') };
  const backend = new FakeBackend(); return { root, cfg, backend, engine: new SyncEngine(cfg, backend) };
}
test('course/resource parsing deduplicates observed IDs, recognizes types and excludes foreign hosts', () => {
  assert.deepEqual(parseCourses([{ href: '/course/view.php?id=101', text: 'ODE' }, { href: '/course/view.php?id=101', text: 'Course name ODE' }, { href: 'https://evil.test/course/view.php?id=9', text: 'bad' }]), [{ id: 101, name: 'ODE', selected: false, hidden: false }]);
  const resources = parseResources(101, [
    { href: '/mod/resource/view.php?id=201', text: 'ODE1 File', context: 'ODE1 PDF' },
    { href: '/mod/folder/view.php?id=10', text: 'Lecture notes Folder' },
    { href: '/mod/url/view.php?id=11', text: 'Reading URL' },
    { href: '/mod/assign/view.php?id=12', text: 'Homework Assignment' },
  ]);
  assert.deepEqual(resources.map(r => r.type), ['file', 'folder', 'url', 'unsupported']); assert.equal(resources[0]?.format, 'PDF');
  assert.throws(() => parseResources(-1, []), /参数/);
});
test('folder paths preserve nested identity and reject traversal', () => {
  const folder = { ...resource, type: 'folder' as const };
  const files = parseFolder(folder, [{ href: '/pluginfile.php/123/mod_folder/content/0/a/notes.pdf', text: 'notes' }, { href: '/pluginfile.php/123/mod_folder/content/0/b/notes.pdf', text: 'notes' }]);
  assert.equal(files.length, 2); assert.notEqual(files[0]?.key, files[1]?.key);
  assert.throws(() => parseFolder(folder, [{ href: '/pluginfile.php/123/mod_folder/content/0/%2e%2e%2fsecret', text: 'bad' }]));
});
test('filenames and URLs cannot escape paths or transmit credentials off-site', () => {
  assert.equal(safeFilename('../../bad\\name.pdf'), '_.._bad_name.pdf');
  assert.throws(() => inside('/safe', '../outside')); assert.throws(() => inside('/safe', '/absolute'));
  assert.throws(() => schoolUrl('https://evil.test/file')); assert.throws(() => schoolUrl('https://moodle.nottingham.ac.uk/pluginfile.php?token=secret'));
  assert.equal(dispositionFilename("attachment; filename*=UTF-8''Lecture%20one.pdf"), 'Lecture one.pdf');
  assert.throws(() => responseCode(403), /权限/); assert.throws(() => responseCode(429), /频率/);
});
test('incremental sync retains old versions, avoids repeat download with ETag and separates same names', async t => {
  const { cfg, backend, engine } = await fixture(t);
  backend.resources.push({ ...resource, moduleId: 9 }); backend.content.set(9, 'second resource');
  const first = await engine.run({ courseIds: [101] }); assert.equal(first.added.length, 2); assert.notEqual(first.added[0]?.path, first.added[1]?.path);
  const second = await engine.run({ courseIds: [101] }); assert.equal(second.unchanged.length, 2); assert.equal(backend.downloads, 2);
  backend.content.set(201, 'changed PDF'); const third = await engine.run({ courseIds: [101] }); assert.equal(third.updated.length, 1);
  assert.equal(await readFile(first.added[0]!.path, 'utf8'), 'first PDF'); assert.equal(await readFile(third.updated[0]!.path, 'utf8'), 'changed PDF');
  const forced = await engine.run({ courseIds: [101], force: true }); assert.equal(forced.unchanged.length, 2); assert.equal(forced.updated.length, 0);
  const state = JSON.parse(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8')); assert.equal(state.files['101:201:main'].versions.length, 2);
  assert.deepEqual(await readdir(join(cfg.stateDir, 'staging')), []);
});
test('failure does not commit, retry succeeds, remote deletion retains files, local edits never overwritten', async t => {
  const { backend, engine } = await fixture(t); backend.failures.add(201);
  const failed = await engine.run({ courseIds: [101] }); assert.equal(failed.failed.length, 1); assert.equal(failed.added.length, 0);
  backend.failures.clear(); const ok = await engine.run({ courseIds: [101] }); assert.equal(ok.added.length, 1);
  await writeFile(ok.added[0]!.path, 'local annotation'); const restored = await engine.run({ courseIds: [101] }); assert.equal(restored.updated.length, 1);
  assert.equal(await readFile(ok.added[0]!.path, 'utf8'), 'local annotation');
  backend.resources = []; const removed = await engine.run({ courseIds: [101] }); assert.equal(removed.remoteMissing.length, 1);
  assert.equal(await readFile(restored.updated[0]!.path, 'utf8'), 'first PDF');
});
test('symlink directories and corrupt state stop safely', async t => {
  const { root, cfg, engine } = await fixture(t); await mkdir(cfg.materialsDir); await symlink(root, join(cfg.materialsDir, '101'));
  const result = await engine.run({ courseIds: [101] }); assert.equal(result.failed[0]?.code, 'PATH_UNSAFE');
  await writeFile(join(cfg.stateDir, 'manifest.json'), '{broken'); await assert.rejects(engine.run({ courseIds: [101] }), /状态损坏/);
});
test('expired login ends sync clearly, and concurrent calls are refused', async t => {
  const { cfg, backend, engine } = await fixture(t);
  backend.listResources = async () => { throw new MoodleError('NEEDS_LOGIN'); };
  const result = await engine.run(); assert.equal(result.needsLogin, true); assert.equal(result.failed.length, 1);
  let release!: () => void; backend.checkConnection = async () => { await new Promise<void>(r => { release = r; }); return { connected: true, authenticated: true, needsLogin: false }; };
  const service = new MoodleService(cfg, () => backend); const pending = service.check();
  while (!release) await new Promise(r => setTimeout(r, 1));
  await assert.rejects(service.check(), /另一个/); release(); await pending;
});
test('unchanged content without validators is checked without creating another version', async t => {
  const { backend, engine } = await fixture(t);
  const download = backend.download.bind(backend);
  backend.download = async (file, dir, _previous, _force) => {
    const result = await download(file, dir, undefined, true);
    if (result.kind === 'downloaded') result.etag = undefined as unknown as string;
    return result;
  };
  const first = await engine.run({ courseIds: [101] }); const second = await engine.run({ courseIds: [101] });
  assert.equal(first.added.length, 1); assert.equal(second.unchanged[0]?.network, 'content_checked');
  assert.equal(second.added.length + second.updated.length, 0); assert.equal(backend.downloads, 2);
});

test('changing semester selection retains historical state and cannot sync deselected courses', async t => {
  const { cfg, backend, engine } = await fixture(t);
  const first = await engine.run(); assert.equal(first.added.length, 1);
  const next = { ...cfg, courses: [{ id: 808, name: 'Next semester' }] };
  backend.resources = [{ ...resource, courseId: 808, moduleId: 202 }]; backend.content.set(202, 'new semester');
  const nextEngine = new SyncEngine(next, backend);
  await assert.rejects(nextEngine.run({ courseIds: [101] }), /参数/);
  assert.equal((await nextEngine.run()).added.length, 1);
  const manifest = JSON.parse(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files['101:201:main']); assert.ok(manifest.files['808:202:main']);
  assert.equal(await readFile(first.added[0]!.path, 'utf8'), 'first PDF');
  await assert.rejects(new SyncEngine({ ...cfg, courses: [] }, backend).run(), /setup/);
});

test('429 stops the whole batch at discovery, folder listing or download', async t => {
  for (const stage of ['discovery', 'files', 'download']) {
    const { cfg, backend } = await fixture(t); cfg.courses.push({ id: 808, name: 'Other course' });
    backend.resources.push({ ...resource, moduleId: 202 }); let calls = 0;
    if (stage === 'discovery') backend.listResources = async () => { calls++; throw new MoodleError('RATE_LIMITED'); };
    else if (stage === 'files') backend.listFiles = async () => { calls++; throw new MoodleError('RATE_LIMITED'); };
    else backend.download = async () => { calls++; throw new MoodleError('RATE_LIMITED'); };
    const result = await new SyncEngine(cfg, backend).run();
    assert.equal(calls, 1); assert.equal(result.failed.length, 1); assert.equal(result.stoppedReason, 'RATE_LIMITED');
    assert.equal(result.needsLogin, false); assert.deepEqual(result.remoteMissing, []);
  }
});

test('failed commit does not report unchanged or missing and cleans manifest temporary files', async t => {
  const { cfg, backend, engine } = await fixture(t);
  await engine.run(); const original = await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8');
  await rm(join(cfg.stateDir, 'manifest.previous.json'));
  await symlink(join(cfg.stateDir, 'manifest.json'), join(cfg.stateDir, 'manifest.previous.json'));
  const result = await engine.run();
  assert.equal(result.unchanged.length, 0); assert.equal(result.failed.length, 1); assert.equal(result.failed[0]?.stage, 'commit');
  assert.equal(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8'), original);
  assert.equal((await readdir(cfg.stateDir)).filter(n => /^manifest-.*\.tmp$/.test(n)).length, 0);
  backend.resources = []; const missing = await engine.run();
  assert.equal(missing.remoteMissing.length, 0); assert.equal(missing.failed[0]?.stage, 'commit');
  assert.equal(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8'), original);
});

test('backend close failure releases the operation lock and busy state', async t => {
  const { cfg, backend } = await fixture(t); let closes = 0;
  backend.close = async () => { if (++closes === 1) throw new Error('close failed'); };
  const service = new MoodleService(cfg, () => backend);
  await assert.rejects(service.check(), (e: unknown) => e instanceof MoodleError && e.code === 'INTERNAL' && e.stage === 'cleanup');
  assert.equal((await readdir(cfg.stateDir)).includes('operation.lock'), false);
  assert.equal((await service.check()).authenticated, true);
});

test('local and internal failures are sanitized and distinct from network retry', async () => {
  const { failure } = await import('../src/model.js');
  assert.deepEqual(failure(Object.assign(new Error('private path'), { code: 'ENOSPC' }), 'commit'), {
    code: 'LOCAL_IO', message: '本地文件操作失败；请检查磁盘空间和访问权限后再调用。', stage: 'commit', retryable: false,
  });
  assert.equal(failure(new TypeError('secret')).code, 'INTERNAL');
  assert.equal(failure(new MoodleError('RATE_LIMITED'), 'download').retryable, true);
});

test('setup confirmation gates download and sync before any backend access', async t => {
  const { cfg, backend } = await fixture(t); const unconfirmed = { ...cfg, setupConfirmed: false };
  const service = new MoodleService(unconfirmed, () => { throw new Error('must not launch'); });
  assert.throws(() => service.download(101, 201), /setup/); assert.throws(() => service.sync(), /setup/);
  await assert.rejects(new SyncEngine(unconfirmed, backend).run(), /setup/);
  assert.equal(service.status().readyToSync, false);
});

test('discovery failure retains previous presence and does not report remote deletion', async t => {
  const { cfg, backend, engine } = await fixture(t); await engine.run();
  const original = await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8');
  backend.listResources = async () => { throw new MoodleError('PARSE_FAILED', undefined, 'discovery'); };
  const result = await engine.run(); assert.equal(result.failed[0]?.stage, 'discovery'); assert.deepEqual(result.remoteMissing, []);
  assert.equal(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8'), original);
});

test('commit failure rolls back the in-memory record for a later retry', async t => {
  const { cfg, backend, engine } = await fixture(t); await engine.run();
  const manifest = JSON.parse(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8'));
  const key = '101:201:main'; const old = structuredClone(manifest.files[key]);
  const internals = engine as unknown as { save: () => Promise<void>; commitRecord: (key: string, record: typeof old, state: typeof manifest) => Promise<void> };
  internals.save = async () => { throw Object.assign(new Error('private path'), { code: 'ENOSPC' }); };
  await assert.rejects(internals.commitRecord(key, { ...old, present: false }, manifest));
  assert.deepEqual(manifest.files[key], old); assert.equal(backend.downloads, 1);
});
