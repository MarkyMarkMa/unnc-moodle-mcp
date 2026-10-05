import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { BrowserBackend } from './browser.js';
import { config, approvedCourse, requireSetup, type Config } from './config.js';
import { MoodleError, atStage, type Backend } from './model.js';
import { privateDirectory } from './safety.js';
import { SyncEngine } from './sync.js';

export class MoodleService {
  private busy = false;
  private activeBackend?: Backend;
  private ownedLock?: string;
  constructor(readonly cfg: Config = config(), private readonly makeBackend: () => Backend = () => new BrowserBackend(cfg)) {}
  async withBackend<T>(action: (backend: Backend) => Promise<T>): Promise<T> {
    if (this.busy) throw new MoodleError('BUSY'); this.busy = true;
    const token = randomUUID(); const lockPath = join(this.cfg.stateDir, 'operation.lock'); let ownsLock = false;
    let backend: Backend | undefined;
    try {
      await privateDirectory(this.cfg.stateDir);
      try {
        const h = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        ownsLock = true; this.ownedLock = lockPath; try { await h.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })); } finally { await h.close(); }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new MoodleError('BUSY'); throw e; }
      backend = this.makeBackend(); this.activeBackend = backend; return await action(backend);
    } finally {
      try { await backend?.close(); }
      catch (e) { throw atStage(e, 'cleanup'); }
      finally {
        try { if (ownsLock) await unlink(lockPath); }
        finally { this.busy = false; this.activeBackend = undefined; this.ownedLock = undefined; }
      }
    }
  }
  async shutdown(): Promise<void> {
    try { await this.activeBackend?.close(); }
    finally { if (this.ownedLock) await unlink(this.ownedLock).catch(() => {}); this.ownedLock = undefined; this.busy = false; this.activeBackend = undefined; }
  }
  check() { return this.withBackend(b => b.checkConnection()); }
  courses() { return this.withBackend(b => b.listCourses()); }
  resources(courseId: number) { approvedCourse(courseId, this.cfg.courses); return this.withBackend(b => b.listResources(courseId)); }
  download(courseId: number, moduleId: number) { requireSetup(this.cfg); approvedCourse(courseId, this.cfg.courses); return this.withBackend(b => new SyncEngine(this.cfg, b).run({ courseIds: [courseId], moduleId })); }
  sync(force = false) { requireSetup(this.cfg); return this.withBackend(b => new SyncEngine(this.cfg, b).run({ force })); }
  status() { return { setupConfirmed: this.cfg.setupConfirmed, readyToSync: this.cfg.setupConfirmed && this.cfg.courses.length > 0, nextStep: !this.cfg.setupConfirmed ? '运行 npm run setup 确认目录与课程' : !this.cfg.courses.length ? '选择已观察到的课程' : '可手动同步', selectedCourses: this.cfg.courses, coursesFile: this.cfg.coursesFile, directories: { materials: this.cfg.materialsDir, state: this.cfg.stateDir }, authentication: 'dedicated-browser-session', automaticScheduling: false }; }
}
