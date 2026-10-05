import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
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
  async listResources(_courseId?: number) { return this.resources; }
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
test('resource section metadata survives duplicate links and folder discovery', () => {
  const parsed = parseResources(101, [
    { href: '/mod/resource/view.php?id=201', text: 'Notes File', context: 'PDF' },
    { href: '/mod/resource/view.php?id=201', text: 'Notes File', sectionName: '  Lecture   Notes ' },
    { href: '/mod/resource/view.php?id=201', text: 'Notes File' },
  ]);
  assert.equal(parsed[0]?.sectionName, 'Lecture Notes');
  assert.equal(parsed[0]?.format, 'PDF');
  assert.equal(resourceFile(parsed[0]!).sectionName, 'Lecture Notes');
  const files = parseFolder({ ...parsed[0]!, title: 'Workshop Materials', type: 'folder' }, [
    { href: '/pluginfile.php/123/mod_folder/content/0/Week%201/Answers/notes.pdf', text: 'notes' },
    { href: '/pluginfile.php/123/mod_folder/content/0/overview.pdf', text: 'overview' },
  ]);
  assert.equal(files[0]?.relativeFolder, 'Week 1/Answers');
  assert.equal(files[1]?.relativeFolder, '');
  assert.equal(files[0]?.sectionName, 'Lecture Notes');
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
  assert.equal(first.added[0]!.path, third.updated[0]!.path); assert.equal(await readFile(third.updated[0]!.path, 'utf8'), 'changed PDF');
  const forced = await engine.run({ courseIds: [101], force: true }); assert.equal(forced.unchanged.length, 2); assert.equal(forced.updated.length, 0);
  const state = JSON.parse(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8')); assert.equal(state.files['101:201:main'].versions.length, 2);
  const history = state.files['101:201:main'].versions;
  assert.ok(history.every((v: { relativePath: string }) => v.relativePath.startsWith('.history/')));
  assert.equal(await readFile(join(cfg.materialsDir, history[0].relativePath), 'utf8'), 'first PDF');
  assert.deepEqual(await readdir(join(cfg.stateDir, 'staging')), []);
});
test('failure does not commit, retry succeeds, remote deletion retains files, local edits never overwritten', async t => {
  const { backend, engine } = await fixture(t); backend.failures.add(201);
  const failed = await engine.run({ courseIds: [101] }); assert.equal(failed.failed.length, 1); assert.equal(failed.added.length, 0);
  backend.failures.clear(); const ok = await engine.run({ courseIds: [101] }); assert.equal(ok.added.length, 1);
  await writeFile(ok.added[0]!.path, 'local annotation'); const restored = await engine.run({ courseIds: [101] }); assert.equal(restored.unchanged.length, 1);
  assert.equal(await readFile(ok.added[0]!.path, 'utf8'), 'local annotation');
  backend.resources = []; const removed = await engine.run({ courseIds: [101] }); assert.equal(removed.remoteMissing.length, 1);
  assert.equal(await readFile(restored.unchanged[0]!.path, 'utf8'), 'first PDF');
});
test('symlink directories and corrupt state stop safely', async t => {
  const { root, cfg, engine } = await fixture(t); await mkdir(join(cfg.materialsDir, '.history'), { recursive: true }); await symlink(root, join(cfg.materialsDir, '.history', '101'));
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

test('quick sync skips existing file requests, downloads new modules and leaves presence untouched', async t => {
  const { backend, engine, cfg } = await fixture(t);
  await engine.run(); const requests = backend.requests;
  backend.content.set(201, 'changed old file');
  backend.resources.push({ ...resource, moduleId: 202 }); backend.content.set(202, 'new lecture');
  const quick = await engine.run({ mode: 'quick' });
  assert.equal(backend.requests, requests + 1); assert.equal(quick.added.length, 1);
  assert.equal(quick.updated.length, 0); assert.equal(quick.unchanged.length, 0); assert.equal(quick.skipped.length, 1);
  backend.resources = [];
  const missing = await engine.run({ mode: 'quick' }); assert.deepEqual(missing.remoteMissing, []);
  const state = JSON.parse(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8'));
  assert.equal(state.files['101:201:main'].present, true);
  backend.resources = [resource];
  const full = await engine.run(); assert.equal(full.updated.length, 1);
  await assert.rejects(engine.run({ mode: 'quick', force: true }), /参数/);
});

test('quick sync retries failed new files and discovers new files inside an existing folder', async t => {
  const { backend, engine } = await fixture(t);
  backend.resources = [{ ...resource, type: 'folder' }];
  const first = resourceFile(resource);
  const second = { ...first, key: '101:201:extra', remotePath: 'extra.pdf' };
  let files = [first]; backend.listFiles = async () => files;
  await engine.run({ mode: 'quick' });
  files = [first, second]; backend.failures.add(201);
  const failed = await engine.run({ mode: 'quick' }); assert.equal(failed.failed.length, 1);
  backend.failures.clear(); const retried = await engine.run({ mode: 'quick' });
  assert.equal(retried.added.length, 1); assert.equal(retried.skipped.length, 1);
  const requests = backend.requests; await engine.run({ mode: 'quick' }); assert.equal(backend.requests, requests);
});

test('legacy numbered files migrate without downloading and preserve user notes', async t => {
  const { cfg, backend, engine } = await fixture(t);
  await engine.run();
  const manifestPath = join(cfg.stateDir, 'manifest.json');
  const state = JSON.parse(await readFile(manifestPath, 'utf8'));
  const record = state.files['101:201:main'];
  const version = record.versions[0];
  const legacyPath = version.relativePath.replace(/^\.history\//, '');
  await mkdir(dirname(join(cfg.materialsDir, legacyPath)), { recursive: true });
  await rename(join(cfg.materialsDir, version.relativePath), join(cfg.materialsDir, legacyPath));
  await rm(join(cfg.materialsDir, record.readablePath));
  version.relativePath = legacyPath;
  delete record.readablePath; delete record.readableHash; delete record.readableFilename;
  await writeFile(join(cfg.materialsDir, 'My notes.md'), 'personal notes');
  await writeFile(manifestPath, JSON.stringify(state));
  const downloads = backend.downloads;
  backend.resources = [{ ...resource, sectionName: 'Lecture Notes' }];
  const migrated = await engine.run({ mode: 'quick' });
  assert.equal(migrated.failed.length, 0); assert.equal(backend.downloads, downloads);
  const next = JSON.parse(await readFile(manifestPath, 'utf8')).files['101:201:main'];
  assert.equal(next.readablePath, 'Example course/Lecture Notes/same.pdf');
  assert.equal(next.versions[0].relativePath, '.history/' + legacyPath);
  assert.equal(await readFile(join(cfg.materialsDir, next.readablePath), 'utf8'), 'first PDF');
  assert.equal(await readFile(join(cfg.materialsDir, 'My notes.md'), 'utf8'), 'personal notes');
  await assert.rejects(readFile(join(cfg.materialsDir, legacyPath)), { code: 'ENOENT' });
});

test('quick sync moves owned files after course and section renames without fetching content', async t => {
  const { cfg, backend, engine } = await fixture(t);
  backend.resources = [{ ...resource, sectionName: 'Lecture Notes' }];
  const first = await engine.run(); const requests = backend.requests;
  cfg.courses[0]!.name = 'Differential Equations';
  backend.resources = [{ ...resource, sectionName: 'Autumn Lectures' }];
  const quick = await engine.run({ mode: 'quick' });
  assert.equal(quick.failed.length, 0); assert.equal(backend.requests, requests);
  assert.equal(await readFile(join(cfg.materialsDir, 'Differential Equations/Autumn Lectures/same.pdf'), 'utf8'), 'first PDF');
  await assert.rejects(readFile(first.added[0]!.path), { code: 'ENOENT' });
  assert.deepEqual((await readdir(cfg.materialsDir)).sort(), ['.history', 'Differential Equations']);
});

test('case-insensitive filename and course collisions retain separate resources', async t => {
  const { cfg, backend, engine } = await fixture(t);
  cfg.courses.push({ id: 102, name: 'example COURSE' });
  backend.resources.push({ ...resource, moduleId: 202 }); backend.content.set(202, 'second PDF');
  backend.listResources = async (courseId = 101) => backend.resources.map(r => ({ ...r, courseId, sectionName: 'Notes' }));
  const download = backend.download.bind(backend);
  backend.download = async (...args) => {
    const result = await download(...args);
    if (result.kind === 'downloaded') result.filename = args[0].moduleId === 201 ? 'Same.pdf' : 'same.pdf';
    return result;
  };
  const first = await engine.run();
  assert.equal(first.failed.length, 0); assert.equal(first.added.length, 4);
  const paths = first.added.map(f => f.path.toLocaleLowerCase());
  assert.equal(new Set(paths).size, 4);
  assert.ok(first.added.some(f => f.path.includes('Example course/')));
  assert.ok(first.added.some(f => f.path.includes('example COURSE (2)')));
  const second = await engine.run();
  assert.equal(second.failed.length, 0); assert.deepEqual(second.unchanged.map(f => f.path), first.added.map(f => f.path));
});

test('long colliding filenames retain their suffix and synchronization terminates', { timeout: 5000 }, async t => {
  const { backend, engine } = await fixture(t);
  backend.resources.push({ ...resource, moduleId: 202 }); backend.content.set(202, 'second PDF');
  const download = backend.download.bind(backend);
  backend.download = async (...args) => {
    const result = await download(...args);
    if (result.kind === 'downloaded') result.filename = 'a'.repeat(220) + '.pdf';
    return result;
  };
  const first = await engine.run();
  assert.equal(first.failed.length, 0); assert.equal(first.added.length, 2);
  const names = first.added.map(f => basename(f.path));
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every(name => Buffer.byteLength(name) <= 175));
  assert.ok(names.some(name => / \(2\)/.test(name)));
  const second = await engine.run();
  assert.equal(second.failed.length, 0);
  assert.deepEqual(second.unchanged.map(f => f.path), first.added.map(f => f.path));
});

test('course suffix allocation cannot collide with another literal course name', async t => {
  const { cfg, backend, engine } = await fixture(t);
  cfg.courses = [{ id: 101, name: 'A' }, { id: 102, name: 'A' }, { id: 103, name: 'A (2)' }];
  backend.listResources = async (courseId = 101) => [{ ...resource, courseId }];
  const result = await engine.run();
  assert.equal(result.failed.length, 0); assert.equal(result.added.length, 3);
  const directories = result.added.map(f => dirname(dirname(f.path)));
  assert.equal(new Set(directories).size, 3);
  assert.deepEqual(directories.map(dir => basename(dir)).sort(), ['A', 'A (2)', 'A (3)']);
  const repeat = await engine.run({ mode: 'quick' });
  assert.equal(repeat.failed.length, 0); assert.equal(repeat.skipped.length, 3);
});

test('organize mode moves existing files but never downloads new files or marks missing resources', async t => {
  const { cfg, backend, engine } = await fixture(t);
  await engine.run(); const requests = backend.requests;
  backend.resources = [{ ...resource, moduleId: 202, sectionName: 'New resources' }];
  backend.content.set(202, 'not downloaded');
  const result = await engine.run({ mode: 'organize' });
  assert.equal(result.failed.length, 0); assert.equal(result.skipped.length, 1);
  assert.equal(result.added.length, 0); assert.deepEqual(result.remoteMissing, []);
  assert.equal(backend.requests, requests);
  const state = JSON.parse(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8'));
  assert.equal(state.files['101:201:main'].present, true);
  assert.equal(state.files['101:202:main'], undefined);
  backend.resources = [{ ...resource, sectionName: 'Renamed section' }];
  const renamed = await engine.run({ mode: 'organize' });
  assert.equal(renamed.failed.length, 0); assert.equal(backend.requests, requests);
  assert.equal(await readFile(join(cfg.materialsDir, 'Example course/Renamed section/same.pdf'), 'utf8'), 'first PDF');
});

test('Moodle folder resources retain title and nested directories', async t => {
  const { cfg, backend, engine } = await fixture(t);
  backend.resources = [{ ...resource, type: 'folder', title: 'Workshop Materials', sectionName: 'Workshops' }];
  backend.listFiles = async folder => parseFolder(folder, [
    { href: '/pluginfile.php/123/mod_folder/content/0/Week%201/Answers/notes.pdf', text: 'notes' },
  ]);
  const download = backend.download.bind(backend);
  backend.download = async (...args) => {
    const result = await download(...args);
    if (result.kind === 'downloaded') result.filename = args[0].filename!;
    return result;
  };
  const result = await engine.run();
  assert.equal(result.failed.length, 0);
  assert.equal(result.added[0]?.path, join(cfg.materialsDir, 'Example course/Workshops/Workshop Materials/Week 1/Answers/notes.pdf'));
  assert.equal(await readFile(result.added[0]!.path, 'utf8'), 'first PDF');
});

test('publishing commit failure rolls back latest copy and cleans temporary files', async t => {
  const { cfg, backend, engine } = await fixture(t);
  const first = await engine.run();
  const manifestPath = join(cfg.stateDir, 'manifest.json');
  const state = JSON.parse(await readFile(manifestPath, 'utf8'));
  const record = state.files['101:201:main'];
  const { publishLatest } = await import('../src/layout.js');
  const changedContent = 'new remote version';
  const latest = record.versions[0];
  const nextPath = latest.relativePath.replace('/v0001/', '/v0002/');
  await mkdir(dirname(join(cfg.materialsDir, nextPath)), { recursive: true });
  await writeFile(join(cfg.materialsDir, nextPath), changedContent);
  record.versions.push({ ...latest, version: 2, relativePath: nextPath, sha256: createHash('sha256').update(changedContent).digest('hex'), bytes: changedContent.length });
  const reject = async () => { throw new MoodleError('LOCAL_IO', undefined, 'commit'); };
  await assert.rejects(publishLatest(cfg, resourceFile(resource), state, reject), (e: unknown) => e instanceof MoodleError && e.stage === 'commit');
  assert.equal(await readFile(first.added[0]!.path, 'utf8'), 'first PDF');
  assert.deepEqual(await readdir(dirname(first.added[0]!.path)), ['same.pdf']);
  await assert.rejects(publishLatest(cfg, resourceFile({ ...resource, sectionName: 'Renamed' }), state, reject));
  assert.deepEqual(await readdir(join(cfg.materialsDir, 'Example course/Renamed')), []);
  assert.equal(await readFile(first.added[0]!.path, 'utf8'), 'first PDF');
  assert.equal(backend.downloads, 1);
});

test('remote updates preserve annotations and keep one stable collision path for latest', async t => {
  const { cfg, backend, engine } = await fixture(t);
  const first = await engine.run();
  await writeFile(first.added[0]!.path, 'my annotations');
  backend.content.set(201, 'remote revision two');
  const second = await engine.run();
  assert.equal(second.failed.length, 0);
  assert.notEqual(second.updated[0]?.path, first.added[0]?.path);
  assert.equal(await readFile(first.added[0]!.path, 'utf8'), 'my annotations');
  assert.equal(await readFile(second.updated[0]!.path, 'utf8'), 'remote revision two');
  backend.content.set(201, 'remote revision three');
  const third = await engine.run();
  assert.equal(third.updated[0]?.path, second.updated[0]?.path);
  assert.equal(await readFile(third.updated[0]!.path, 'utf8'), 'remote revision three');
  const state = JSON.parse(await readFile(join(cfg.stateDir, 'manifest.json'), 'utf8'));
  const versions = state.files['101:201:main'].versions;
  assert.equal(versions.length, 3);
  assert.equal(await readFile(join(cfg.materialsDir, versions[0].relativePath), 'utf8'), 'first PDF');
  assert.equal(await readFile(first.added[0]!.path, 'utf8'), 'my annotations');
});
