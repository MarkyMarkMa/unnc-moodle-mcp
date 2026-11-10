import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BrowserBackend } from './browser.js';
import { config, approvedCourse, requireSetup, type Config } from './config.js';
import { MoodleError, atStage, failure, type Backend } from './model.js';
import { regularFile } from './safety.js';
import { acquireOperation, inspectOperation, releaseOperation, type Operation } from './operation.js';
import { JobStore, emptyCounts, summaryCounts, taskView, type SyncTask, type ProgressReporter } from './jobs.js';
import { SyncEngine } from './sync.js';

export class MoodleService {
  private busy = false;
  private activeBackend?: Backend;
  constructor(readonly cfg: Config = config(), private readonly makeBackend: () => Backend = () => new BrowserBackend(cfg)) { this.jobs = new JobStore(cfg.stateDir); }
  private readonly jobs: JobStore;
  private activeTask?: SyncTask;
  private activeRun?: Promise<void>;
  private closing = false;
  async withBackend<T>(action: (backend: Backend) => Promise<T>, operation = 'browser'): Promise<T> {
    if (this.busy || this.closing) throw new MoodleError('BUSY'); this.busy = true;
    let owned: Operation | undefined;
    let backend: Backend | undefined;
    try {
      const lock = await acquireOperation(this.cfg.stateDir, operation); owned = lock.owned;
      if (lock.recovered?.taskId) await this.jobs.recover(lock.recovered.taskId);
      backend = this.makeBackend(); this.activeBackend = backend; return await action(backend);
    } finally {
      try { await backend?.close(); }
      catch (e) { throw atStage(e, 'cleanup'); }
      finally {
        try { if (owned) await releaseOperation(this.cfg.stateDir, owned); }
        finally { this.busy = false; this.activeBackend = undefined; }
      }
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.activeBackend?.close();
    // Do not release a live operation's lock until its engine and final save end.
    await this.activeRun;
  }
  async syncStatus(taskId?: string) {
    const lock = await inspectOperation(this.cfg.stateDir);
    const requested = taskId ?? (lock.state !== 'idle' ? lock.taskId : undefined);
    const useMemory = requested ? requested === this.activeTask?.taskId : this.activeTask?.status === 'running' || this.activeTask?.resultSaved === false;
    const task = useMemory ? this.activeTask : await this.jobs.read(requested);
    if (taskId && !task) throw new MoodleError('NOT_FOUND');
    return { task: taskView(task), lock, recoveryGuard: !!await regularFile(this.cfg.stateDir, 'operation-recovery.lock') };
  }
  async startSync(force = false, mode: 'full' | 'quick' | 'organize' = force ? 'full' : 'quick') {
    requireSetup(this.cfg);
    if (force && mode !== 'full') throw new MoodleError('INVALID_INPUT');
    if (this.busy || this.closing) return { started: false, ...await this.syncStatus() };
    this.busy = true;
    const taskId = randomUUID(); let owned: Operation | undefined;
    try {
      const current = await this.syncStatus();
      if (current.lock.state === 'active') { this.busy = false; return { started: false, ...current }; }
      const lock = await acquireOperation(this.cfg.stateDir, 'sync', taskId); owned = lock.owned;
      if (lock.recovered?.taskId) await this.jobs.recover(lock.recovered.taskId);
      const previous = await this.jobs.read(); if (previous) await this.jobs.recover(previous.taskId);
      const now = new Date().toISOString();
      const task: SyncTask = { schemaVersion: 1, taskId, pid: process.pid, mode, forceContentCheck: force, status: 'running', startedAt: now, updatedAt: now,
        progress: { stage: 'starting', totalCourses: this.cfg.courses.length, completedCourses: 0, discoveredResources: 0, processedFiles: 0, counts: emptyCounts() } };
      await this.jobs.save(task); await this.jobs.setLatest(taskId); this.activeTask = task;
      const initial = taskView(task);
      this.activeRun = this.runTask(task, owned);
      return { started: true, task: initial, lock: { state: 'active' as const, ...owned }, recoveredStaleLock: !!lock.recovered };
    } catch (e) {
      try { if (owned) await releaseOperation(this.cfg.stateDir, owned); }
      finally { this.busy = false; }
      if (e instanceof MoodleError && e.code === 'BUSY') return { started: false, ...await this.syncStatus() };
      throw e;
    }
  }
  private async runTask(task: SyncTask, owned: Operation): Promise<void> {
    let backend: Backend | undefined;
    const report: ProgressReporter = async patch => {
      if (this.closing) throw new MoodleError('INTERNAL');
      task.progress = { ...task.progress, ...patch }; task.updatedAt = new Date().toISOString();
      // A failed status write must not turn into a successful sync. Retain the
      // error in memory, then stop at the next resource boundary.
      try { await this.jobs.save(task); }
      catch (e) { task.persistenceError = failure(e, 'commit'); throw e; }
    };
    try {
      backend = this.makeBackend(); this.activeBackend = backend; backend.setProgressReporter?.(report);
      task.summary = await new SyncEngine(this.cfg, backend).run({ force: task.forceContentCheck, mode: task.mode, onProgress: report, shouldStop: () => this.closing || !!task.persistenceError });
      task.progress.counts = summaryCounts(task.summary);
      task.status = this.closing ? 'interrupted' : task.persistenceError ? 'failed' : task.summary.stoppedReason ? 'stopped' : task.summary.failed.length ? 'completed_with_errors' : 'completed';
    } catch (e) { task.error = failure(e); task.status = this.closing ? 'interrupted' : 'failed'; }
    finally {
      try { await backend?.close(); }
      catch (e) { task.error = failure(e, 'cleanup'); task.status = 'failed'; }
      task.finishedAt = new Date().toISOString(); task.updatedAt = task.finishedAt; task.progress.stage = 'finished'; task.resultSaved = true;
      try { await this.jobs.save(task); }
      catch (e) { task.resultSaved = false; task.persistenceError = failure(e, 'commit'); task.status = 'failed'; }
      try { await releaseOperation(this.cfg.stateDir, owned); }
      catch (e) { task.error = failure(e, 'cleanup'); task.status = 'failed'; try { await this.jobs.save(task); } catch { task.resultSaved = false; } }
      finally { this.busy = false; this.activeBackend = undefined; }
    }
  }
  login(run = () => this.launchLogin()) {
    return this.withBackend(async b => { await run(); return b.checkConnection(); }, 'login');
  }
  private async launchLogin(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/login.mjs', import.meta.url))], {
        stdio: 'ignore', env: { ...process.env, MOODLE_PROFILE_DIR: this.cfg.profileDir },
      });
      const stop = () => { child.kill('SIGTERM'); };
      const timer = setTimeout(stop, 300_000);
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      const cleanup = () => { clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); };
      child.once('error', () => { cleanup(); reject(new MoodleError('INTERNAL')); });
      child.once('exit', code => { cleanup(); if (code === 0) resolve(); else reject(new MoodleError('NEEDS_LOGIN')); });
    });
  }
  check() { return this.withBackend(b => b.checkConnection(), 'check_connection'); }
  courses() { return this.withBackend(b => b.listCourses(), 'list_courses'); }
  resources(courseId: number) { approvedCourse(courseId, this.cfg.courses); return this.withBackend(b => b.listResources(courseId), 'list_resources'); }
  download(courseId: number, moduleId: number) { requireSetup(this.cfg); approvedCourse(courseId, this.cfg.courses); return this.withBackend(b => new SyncEngine(this.cfg, b).run({ courseIds: [courseId], moduleId }), 'download_resource'); }
  sync(force = false, mode: 'full' | 'quick' | 'organize' = force ? 'full' : 'quick') { requireSetup(this.cfg); return this.waitForSync(force, mode); }
  private async waitForSync(force: boolean, mode: 'full' | 'quick' | 'organize') {
    const result = await this.startSync(force, mode);
    if (!result.started) throw new MoodleError('BUSY');
    await this.activeRun; const task = this.activeTask!;
    if (task.status === 'failed' || task.status === 'interrupted' || !task.summary) throw new MoodleError(task.error?.code ?? task.persistenceError?.code ?? 'INTERNAL');
    return task.summary;
  }
  status() { return { defaultSyncMode: 'quick', syncResult: 'task', organization: this.cfg.routing ?? { mode: 'managed' }, setupConfirmed: this.cfg.setupConfirmed, readyToSync: this.cfg.setupConfirmed && this.cfg.courses.length > 0, nextStep: !this.cfg.setupConfirmed ? '运行 npm run setup 确认目录与课程' : !this.cfg.courses.length ? '选择已观察到的课程' : '可手动同步', selectedCourses: this.cfg.courses, coursesFile: this.cfg.coursesFile, directories: { materials: this.cfg.materialsDir, output: this.cfg.routing?.mode === 'existing' ? this.cfg.routing.root : this.cfg.materialsDir, state: this.cfg.stateDir }, authentication: 'dedicated-browser-session', automaticScheduling: false }; }
}
