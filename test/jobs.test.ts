import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MoodleService } from '../src/service.js';
import { config, type Config } from '../src/config.js';
import { MoodleError, type Backend, type Resource } from '../src/model.js';
import { acquireOperation, inspectOperation, releaseOperation } from '../src/operation.js';
import { JobStore } from '../src/jobs.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'moodle-job-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cfg: Config = { ...config(), setupConfirmed: true, courses: [{ id: 101, name: 'Synthetic' }], dataDir: root, stateDir: join(root, 'state'), materialsDir: join(root, 'materials'), profileDir: join(root, 'profile') };
  await mkdir(cfg.stateDir);
  return { root, cfg };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function backend(listResources: () => Promise<Resource[]> = async () => []): Backend {
  return { listResources, close: async () => {}, listCourses: async () => [], checkConnection: async () => ({ connected: true, authenticated: true, needsLogin: false }), listFiles: async () => [], download: async () => { throw Error('unexpected download'); } };
}
async function finish(service: MoodleService, taskId?: string) {
  for (let i = 0; i < 200; i++) { const s = await service.syncStatus(taskId); if (s.task?.status !== 'running' && s.lock.state === 'idle') return s; await new Promise(r => setTimeout(r, 5)); }
  throw Error('task failed to finish');
}
test('long operation returns immediately, reports progress during BUSY, deduplicates and saves final summary', async t => {
  const { cfg } = await fixture(t), waiting = gate(), entered = gate(); let discoveries = 0;
  const service = new MoodleService(cfg, () => backend(async () => { discoveries++; entered.resolve(); await waiting.promise; return []; }));
  const started = await service.startSync(); assert.equal(started.started, true); assert.equal(started.task?.mode, 'quick');
  await entered.promise;
  const live = await service.syncStatus(); assert.equal(live.task?.progress.stage, 'discovery'); assert.equal(live.lock.state, 'active');
  await assert.rejects(service.check(), /另一个同步/);
  const duplicate = await service.startSync(false, 'full'); assert.equal(duplicate.started, false); assert.equal(duplicate.task?.taskId, started.task?.taskId); assert.equal(discoveries, 1);
  // There is no per-call timer: a persisted job older than the former 600s
  // request limit remains queryable and a live lock must not be reclaimed.
  const observer = new MoodleService(cfg);
  const store = new JobStore(cfg.stateDir); const disk = (await store.read())!;
  disk.startedAt = new Date(Date.now() - 700_000).toISOString(); disk.updatedAt = disk.startedAt; await store.save(disk);
  const old = await observer.syncStatus(); assert.equal(old.task?.status, 'running'); assert.equal(old.task?.awaitingProgress, true); assert.ok(old.task!.elapsedMs > 600_000);
  const otherStart = await observer.startSync(); assert.equal(otherStart.started, false); assert.equal(otherStart.task?.taskId, started.task?.taskId);
  waiting.resolve(); const done = await finish(service);
  assert.equal(done.task?.status, 'completed'); assert.equal(done.task?.resultSaved, true); assert.equal(done.lock.state, 'idle');
  const restarted = await new MoodleService(cfg).syncStatus(started.task!.taskId);
  assert.deepEqual(restarted.task?.summary, done.task?.summary);
  if (process.platform !== 'win32') assert.equal((await lstat(join(cfg.stateDir, 'sync-jobs', started.task!.taskId + '.json'))).mode & 0o777, 0o600);
});
test('partial business failures, retries and stoppedReason remain explicit in persisted results', async t => {
  const { cfg } = await fixture(t); let report: Parameters<NonNullable<Backend['setProgressReporter']>>[0] | undefined;
  const entered = gate(), waiting = gate();
  const fake = backend(async () => [{ courseId: 101, moduleId: 201, title: 'Synthetic notes', type: 'file', url: 'https://moodle.nottingham.ac.uk/mod/resource/view.php?id=201' }]);
  fake.setProgressReporter = r => { report = r; };
  fake.listFiles = async r => [{ ...r, key: '101:201:main', remotePath: 'main' }];
  fake.download = async () => { await report?.({ stage: 'retry', attempt: 3 }); entered.resolve(); await waiting.promise; throw new MoodleError('NETWORK', 3, 'download', true); };
  const service = new MoodleService(cfg, () => fake); await service.startSync(); await entered.promise;
  const live = await service.syncStatus(); assert.equal(live.task?.progress.attempt, 3); assert.equal(live.task?.progress.moduleId, 201);
  waiting.resolve(); const done = await finish(service); assert.equal(done.task?.status, 'completed_with_errors');
  assert.equal(done.task?.summary?.failed[0]?.attempts, 3); assert.equal(done.task?.progress.processedFiles, 1); assert.equal(done.task?.progress.counts.failed, 1);
  const stopped = new MoodleService(cfg, () => backend(async () => { throw new MoodleError('RATE_LIMITED'); }));
  await stopped.startSync(); const result = await finish(stopped); assert.equal(result.task?.status, 'stopped'); assert.equal(result.task?.summary?.stoppedReason, 'RATE_LIMITED'); assert.equal(result.lock.state, 'idle');
});
test('process crash is observable and the next sync recovers its stale lock without deleting materials', async t => {
  const { cfg } = await fixture(t);
  const script = `import { MoodleService } from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)};
  const cfg = JSON.parse(process.argv[1]); const b={listResources:async()=>new Promise(()=>{}),close:async()=>{}};
  const s=new MoodleService(cfg,()=>b); await s.startSync(); console.log('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data'); const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  const observer = new MoodleService(cfg, () => backend()); const crashed = await observer.syncStatus();
  assert.equal(crashed.lock.state, 'stale'); assert.equal(crashed.task?.status, 'interrupted');
  await mkdir(cfg.materialsDir); await writeFile(join(cfg.materialsDir, 'notes.txt'), 'user notes');
  const next = await observer.startSync(); assert.equal(next.started, true); assert.equal('recoveredStaleLock' in next && next.recoveredStaleLock, true);
  await finish(observer); assert.equal(await readFile(join(cfg.materialsDir, 'notes.txt'), 'utf8'), 'user notes');
  const old = await observer.syncStatus(crashed.task!.taskId); assert.equal(old.task?.status, 'interrupted');
});
test('active legacy locks stay protected; unsafe/corrupt locks and task paths are refused', async t => {
  const { cfg, root } = await fixture(t); const lock = join(cfg.stateDir, 'operation.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'legacy', startedAt: '2020-01-01T00:00:00.000Z' }));
  const service = new MoodleService(cfg); assert.equal((await service.startSync()).started, false);
  await assert.rejects(service.check(), /另一个同步/); await rm(lock);
  const outside = join(root, 'outside'); await writeFile(outside, 'keep'); await symlink(outside, lock);
  await assert.rejects(service.startSync(), /不安全/); assert.equal(await readFile(outside, 'utf8'), 'keep'); await rm(lock);
  await writeFile(lock, '{}'); await assert.rejects(service.startSync(), /状态损坏/); await rm(lock);
  await assert.rejects(service.syncStatus('../escape'), /参数/);
  await symlink(root, join(cfg.stateDir, 'sync-jobs')); await assert.rejects(service.startSync(), /不安全/);
  assert.equal((await inspectOperation(cfg.stateDir)).state, 'idle');
});
test('concurrent services start only one task and cleanup never deletes a different owner', async t => {
  const { cfg } = await fixture(t); const waiting = gate(); const make = () => backend(async () => { await waiting.promise; return []; });
  const a = new MoodleService(cfg, make), b = new MoodleService(cfg, make);
  const results = await Promise.allSettled([a.startSync(), b.startSync()]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.started).length, 1);
  waiting.resolve(); await finish(a); await finish(b);
  const { owned } = await acquireOperation(cfg.stateDir, 'synthetic');
  await releaseOperation(cfg.stateDir, { ...owned, token: randomUUID() }); assert.equal((await inspectOperation(cfg.stateDir)).state, 'active');
  await releaseOperation(cfg.stateDir, owned); assert.equal((await inspectOperation(cfg.stateDir)).state, 'idle');
});
test('shutdown marks active task interrupted and waits for final persistence before unlocking', async t => {
  const { cfg } = await fixture(t), waiting = gate(), entered = gate();
  const fake = backend(async () => { entered.resolve(); await waiting.promise; throw new MoodleError('NETWORK'); }); fake.close = async () => { waiting.resolve(); };
  const service = new MoodleService(cfg, () => fake); await service.startSync(); await entered.promise; await service.shutdown();
  const status = await service.syncStatus(); assert.equal(status.task?.status, 'interrupted'); assert.equal(status.task?.resultSaved, true); assert.equal(status.lock.state, 'idle');
});
test('status write failure is explicit and cannot silently report a saved successful result', async t => {
  const { cfg } = await fixture(t), waiting = gate(), entered = gate();
  const service = new MoodleService(cfg, () => backend(async () => { entered.resolve(); await waiting.promise; return []; }));
  const started = await service.startSync(); await entered.promise;
  const path = join(cfg.stateDir, 'sync-jobs', started.task!.taskId + '.json'); await rm(path); await mkdir(path); waiting.resolve();
  // Reading the persisted path must refuse it; the in-process task still exposes
  // the final save error without claiming success.
  for (let i = 0; i < 100; i++) { const s = await service.syncStatus(started.task!.taskId); if (s.task?.status !== 'running') { assert.equal(s.task?.status, 'failed'); assert.equal(s.task?.resultSaved, false); assert.ok(s.task?.persistenceError); break; } await new Promise(r => setTimeout(r, 5)); }
  assert.equal((await inspectOperation(cfg.stateDir)).state, 'idle');
  assert.equal((await readdir(cfg.stateDir)).some(n => n.endsWith('.tmp')), false);
});

test('same-service concurrent starts and recovery guard never allow a second engine', async t => {
  const { cfg } = await fixture(t); const waiting = gate(); let calls = 0;
  const service = new MoodleService(cfg, () => backend(async () => { calls++; await waiting.promise; return []; }));
  const starts = await Promise.all([service.startSync(), service.startSync()]);
  assert.equal(starts.filter(s => s.started).length, 1); waiting.resolve(); await finish(service); assert.equal(calls, 1);
  await writeFile(join(cfg.stateDir, 'operation-recovery.lock'), '{}');
  assert.equal((await service.syncStatus()).recoveryGuard, true);
  const blocked = await service.startSync(); assert.equal(blocked.started, false); assert.equal(calls, 1);
});

test('already migrated configuration can start with a live lock and query its owner', async t => {
  const { root } = await fixture(t);
  const dataDir = join(root, 'data'), stateDir = join(dataDir, '_moodle', 'state'); await mkdir(stateDir, { recursive: true });
  const coursesFile = join(dataDir, '_moodle', 'courses.json'); await writeFile(coursesFile, '[{"id":101,"name":"Synthetic"}]');
  const settingsFile = join(root, 'settings.json'); await writeFile(settingsFile, JSON.stringify({ schemaVersion: 1, confirmed: true, dataDir, coursesFile }));
  const { owned } = await acquireOperation(stateDir, 'synthetic-existing-operation');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { MoodleService } from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)}; console.log(JSON.stringify(await new MoodleService().syncStatus()));`], {
    env: { ...process.env, MOODLE_SETTINGS_FILE: settingsFile, MOODLE_DATA_DIR: dataDir, MOODLE_COURSES_FILE: coursesFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 0, stderr); assert.equal(JSON.parse(stdout).lock.operation, 'synthetic-existing-operation');
  await releaseOperation(stateDir, owned);
});

test('status never reads a partially published new lock under concurrent inspection', async t => {
  const { cfg } = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const acquisition = acquireOperation(cfg.stateDir, 'synthetic');
    await Promise.all(Array.from({ length: 5 }, () => inspectOperation(cfg.stateDir)));
    const lock = await acquisition;
    assert.equal((await inspectOperation(cfg.stateDir)).state, 'active'); await releaseOperation(cfg.stateDir, lock.owned);
  }
});

test('malformed saved task and mismatched task ID are refused without overwriting the record', async t => {
  const { cfg } = await fixture(t); const service = new MoodleService(cfg, () => backend());
  const started = await service.startSync(); await finish(service);
  const path = join(cfg.stateDir, 'sync-jobs', started.task!.taskId + '.json');
  const saved = JSON.parse(await readFile(path, 'utf8')); saved.taskId = randomUUID(); await writeFile(path, JSON.stringify(saved));
  await assert.rejects(new MoodleService(cfg).syncStatus(), /状态损坏/);
  const before = await readFile(path, 'utf8'); await assert.rejects(service.startSync(), /状态损坏/); assert.equal(await readFile(path, 'utf8'), before);
});
