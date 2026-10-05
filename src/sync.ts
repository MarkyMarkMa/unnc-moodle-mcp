import { constants } from 'node:fs';
import { link, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { approvedCourse, requireSetup, type Config } from './config.js';
import { MoodleError, failure, atStage, type Backend, type Manifest, type RemoteFile, type StoredFile, type SyncSummary } from './model.js';
import { fileHash, fileSlot, inside, privateDirectory, regularFile, removeStaging, safeDirectory, safeFilename } from './safety.js';

const versionSchema = z.object({ version: z.number().int().positive(), relativePath: z.string(), filename: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), savedAt: z.string() });
const storedSchema = z.object({ key: z.string(), courseId: z.number().int(), moduleId: z.number().int().positive(), remotePath: z.string(), title: z.string(), etag: z.string().optional(), lastModified: z.string().optional(), mime: z.string().optional(), present: z.boolean(), lastCheckedAt: z.string(), versions: z.array(versionSchema).min(1) });
const manifestSchema = z.object({ schemaVersion: z.literal(1), files: z.record(z.string(), storedSchema) });

export class SyncEngine {
  constructor(private readonly cfg: Config, private readonly backend: Backend) {}
  private async load(): Promise<Manifest> {
    const path = await regularFile(this.cfg.stateDir, 'manifest.json');
    if (!path) return { schemaVersion: 1, files: {} };
    try {
      const state = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      for (const [key, f] of Object.entries(state.files)) {
        if (key !== f.key || !Number.isSafeInteger(f.courseId) || f.courseId <= 0) throw new Error();
        for (const v of f.versions) inside(this.cfg.materialsDir, v.relativePath);
      }
      return state;
    } catch (e) {
      if (e instanceof MoodleError) throw e;
      if (e instanceof SyntaxError || e instanceof z.ZodError) throw new MoodleError('STATE_INVALID');
      const classified = atStage(e, 'local');
      if (classified.code === 'LOCAL_IO') throw classified;
      throw new MoodleError('STATE_INVALID');
    }
  }
  private async save(state: Manifest): Promise<void> {
    const temporary = join(this.cfg.stateDir, 'manifest-' + randomUUID() + '.tmp');
    let created = false;
    try {
      const h = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await h.writeFile(JSON.stringify(state, null, 2) + '\n'); await h.sync(); }
      finally { await h.close(); }
      const old = await regularFile(this.cfg.stateDir, 'manifest.json');
      if (old) {
        const backup = join(this.cfg.stateDir, 'manifest.previous.json');
        const b = await lstat(backup).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
        if (b?.isSymbolicLink()) throw new MoodleError('PATH_UNSAFE');
        if (b) await unlink(backup);
        await link(old, backup);
      }
      await rename(temporary, join(this.cfg.stateDir, 'manifest.json'));
    } catch (e) { throw atStage(e, 'commit'); }
    finally { if (created) await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw atStage(e, 'commit'); }); }
  }
  private async processFile(file: RemoteFile, state: Manifest, summary: SyncSummary, force: boolean): Promise<void> {
    const old = state.files[file.key]; const latest = old?.versions.at(-1);
    const local = latest ? await regularFile(this.cfg.materialsDir, latest.relativePath) : undefined;
    const localValid = !!local && await fileHash(local) === latest!.sha256;
    let downloaded;
    try {
      try { downloaded = await this.backend.download(file, join(this.cfg.stateDir, 'staging'), localValid ? old : undefined, force || !localValid); }
      catch (e) { throw atStage(e, 'download'); }
      if (downloaded.kind === 'not_modified') {
        if (!old || !localValid) throw new MoodleError('PARSE_FAILED');
        const changed = { ...old, present: true, lastCheckedAt: new Date().toISOString() };
        await this.commitRecord(file.key, changed, state);
        summary.unchanged.push({ key: file.key, path: local!, network: 'not_modified', attempts: downloaded.attempts }); return;
      }
      if (!downloaded.stagingPath || !downloaded.sha256 || downloaded.bytes === undefined) throw new MoodleError('PARSE_FAILED');
      if (localValid && downloaded.sha256 === latest!.sha256) {
        const changed = { ...old!, etag: downloaded.etag, lastModified: downloaded.lastModified, mime: downloaded.mime, present: true, lastCheckedAt: new Date().toISOString() };
        await this.commitRecord(file.key, changed, state);
        summary.unchanged.push({ key: file.key, path: local!, network: 'content_checked', attempts: downloaded.attempts }); return;
      }
      const filename = safeFilename(downloaded.filename ?? file.filename ?? file.title);
      const slot = `${file.courseId}/${file.moduleId}/${fileSlot(file.remotePath)}`;
      let number = (latest?.version ?? 0) + 1; let destination = '';
      for (;;) {
        const dir = await safeDirectory(this.cfg.materialsDir, `${slot}/v${String(number).padStart(4, '0')}`);
        destination = join(dir, filename);
        try { await link(downloaded.stagingPath, destination); break; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; number++; }
      }
      const now = new Date().toISOString();
      const record: StoredFile = { key: file.key, courseId: file.courseId, moduleId: file.moduleId, remotePath: file.remotePath, title: file.title,
        etag: downloaded.etag, lastModified: downloaded.lastModified, mime: downloaded.mime, present: true, lastCheckedAt: now,
        versions: [...(old?.versions ?? []), { version: number, relativePath: relative(this.cfg.materialsDir, destination), filename, sha256: downloaded.sha256, bytes: downloaded.bytes, savedAt: now }] };
      try { await this.commitRecord(file.key, record, state); }
      catch (e) { await unlink(destination); throw e; }
      (old ? summary.updated : summary.added).push({ key: file.key, path: destination, attempts: downloaded.attempts });
    } catch (e) { throw atStage(e, 'local'); }
    finally { await removeStaging(downloaded?.stagingPath); }
  }
  private async commitRecord(key: string, record: StoredFile, state: Manifest): Promise<void> {
    const previous = state.files[key]; state.files[key] = record;
    try { await this.save(state); }
    catch (e) { if (previous) state.files[key] = previous; else delete state.files[key]; throw e; }
  }
  private stop(code: string, summary: SyncSummary): boolean {
    if (code !== 'NEEDS_LOGIN' && code !== 'RATE_LIMITED') return false;
    summary.stoppedReason = code; summary.needsLogin = code === 'NEEDS_LOGIN'; return true;
  }
  async run(options: { courseIds?: number[]; moduleId?: number; force?: boolean; mode?: 'full' | 'quick' } = {}): Promise<SyncSummary> {
    requireSetup(this.cfg);
    if (options.mode === 'quick' && options.force) throw new MoodleError('INVALID_INPUT');
    const ids = options.courseIds ?? this.cfg.courses.map(c => c.id); ids.forEach(id => approvedCourse(id, this.cfg.courses));
    if (!ids.length || new Set(ids).size !== ids.length) throw new MoodleError('INVALID_INPUT');
    await privateDirectory(this.cfg.dataDir); await privateDirectory(this.cfg.stateDir); await privateDirectory(this.cfg.materialsDir);
    const state = await this.load();
    const recordedModules = new Set(Object.values(state.files).map(f => `${f.courseId}:${f.moduleId}`));
    const summary: SyncSummary = { added: [], updated: [], unchanged: [], failed: [], skipped: [], remoteMissing: [], needsLogin: false };
    for (const courseId of ids) {
      let complete = options.moduleId === undefined && options.mode !== 'quick'; const seen = new Set<string>();
      try {
        let resources: Awaited<ReturnType<Backend['listResources']>>;
        try { resources = await this.backend.listResources(courseId); } catch (e) { throw atStage(e, 'discovery'); }
        if (options.moduleId !== undefined) {
          resources = resources.filter(r => r.moduleId === options.moduleId);
          if (!resources.length) throw new MoodleError('NOT_FOUND');
        }
        for (const resource of resources) {
          if (!['file', 'folder'].includes(resource.type)) {
            summary.skipped.push({ courseId, moduleId: resource.moduleId, title: resource.title, reason: resource.type === 'url' ? '外链资源仅报告，不自动跟随' : `不下载 ${resource.type} 类型` }); continue;
          }
          if (options.mode === 'quick' && resource.type === 'file' && recordedModules.has(`${courseId}:${resource.moduleId}`)) {
            summary.skipped.push({ courseId, moduleId: resource.moduleId, title: resource.title, reason: '快速模式：已有模块未检查更新或本地完整性' }); continue;
          }
          let files: RemoteFile[];
          try { files = await this.backend.listFiles(resource); }
          catch (e) {
            complete = false; const f = failure(e, 'discovery'); summary.failed.push({ courseId, moduleId: resource.moduleId, ...f });
            if (this.stop(f.code, summary)) return summary; continue;
          }
          for (const file of files) {
            seen.add(file.key);
            if (options.mode === 'quick' && state.files[file.key]) {
              summary.skipped.push({ courseId, moduleId: resource.moduleId, title: resource.title, reason: '快速模式：已有文件未检查更新或本地完整性' }); continue;
            }
            try { await this.processFile(file, state, summary, options.force ?? false); }
            catch (e) {
              complete = false; const f = failure(e, 'download'); summary.failed.push({ courseId, moduleId: resource.moduleId, key: file.key, ...f });
              if (this.stop(f.code, summary)) return summary;
            }
          }
        }
        if (complete) {
          const previous = state.files;
          const missing = Object.values(previous).filter(f => f.courseId === courseId && !seen.has(f.key));
          state.files = { ...previous };
          for (const f of missing) state.files[f.key] = { ...f, present: false };
          try { await this.save(state); } catch (e) { state.files = previous; throw e; }
          summary.remoteMissing.push(...missing.map(f => f.key));
        }
      } catch (e) {
        const f = failure(e); summary.failed.push({ courseId, ...f });
        if (this.stop(f.code, summary)) break;
      }
    }
    return summary;
  }
}
