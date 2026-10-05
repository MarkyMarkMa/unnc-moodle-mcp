import { routeFile, checkRouteDirectory } from './routing.js';
import { isAbsolute } from 'node:path';
import { constants } from 'node:fs';
import { link, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { approvedCourse, requireSetup, type Config } from './config.js';
import { MoodleError, failure, atStage, type Backend, type Manifest, type RemoteFile, type StoredFile, type SyncSummary } from './model.js';
import { fileHash, fileSlot, inside, privateDirectory, regularFile, removeStaging, safeDirectory, safeFilename } from './safety.js';

import { publishLatest, pruneEmpty } from './layout.js';

const versionSchema = z.object({ version: z.number().int().positive(), relativePath: z.string(), filename: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), savedAt: z.string() });
const storedSchema = z.object({ routingDirectory: z.string().optional(), readableRoot: z.string().optional(), readablePath: z.string().optional(), readableHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), readableFilename: z.string().optional(), key: z.string(), courseId: z.number().int(), moduleId: z.number().int().positive(), remotePath: z.string(), title: z.string(), etag: z.string().optional(), lastModified: z.string().optional(), mime: z.string().optional(), present: z.boolean(), lastCheckedAt: z.string(), versions: z.array(versionSchema).min(1) });
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
        if (f.readableRoot && !isAbsolute(f.readableRoot)) throw new MoodleError('STATE_INVALID');
        if (f.readablePath) { inside(f.readableRoot ?? this.cfg.materialsDir, f.readablePath); if (f.readablePath.replaceAll('\\', '/').startsWith('.history/')) throw new MoodleError('STATE_INVALID'); }
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
      const slot = `.history/${file.courseId}/${file.moduleId}/${fileSlot(file.remotePath)}`;
      let number = (latest?.version ?? 0) + 1; let destination = '';
      for (;;) {
        const dir = await safeDirectory(this.cfg.materialsDir, `${slot}/v${String(number).padStart(4, '0')}`);
        destination = join(dir, filename);
        try { await link(downloaded.stagingPath, destination); break; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; number++; }
      }
      const now = new Date().toISOString();
      const record: StoredFile = { ...(old ?? {}), key: file.key, courseId: file.courseId, moduleId: file.moduleId, remotePath: file.remotePath, title: file.title,
        etag: downloaded.etag, lastModified: downloaded.lastModified, mime: downloaded.mime, present: true, lastCheckedAt: now,
        versions: [...(old?.versions ?? []), { version: number, relativePath: relative(this.cfg.materialsDir, destination).split('\\').join('/'), filename, sha256: downloaded.sha256, bytes: downloaded.bytes, savedAt: now }] };
      try { await this.commitRecord(file.key, record, state); }
      catch (e) { await unlink(destination); throw e; }
      (old ? summary.updated : summary.added).push({ key: file.key, path: destination, attempts: downloaded.attempts });
    } catch (e) { throw atStage(e, 'local'); }
    finally { await removeStaging(downloaded?.stagingPath); }
  }
  private async organize(file: RemoteFile, state: Manifest): Promise<string | undefined> {
    const initial = state.files[file.key];
    if (!initial) return;
    let record: StoredFile = initial;
    for (let i = 0; i < record.versions.length; i++) {
      const version = record.versions[i]!;
      if (version.relativePath.replaceAll('\\', '/').startsWith('.history/')) {
        const legacyPath = version.relativePath.slice('.history/'.length);
        const legacy = /^\d+[\\/]\d+[\\/]/.test(legacyPath) ? await regularFile(this.cfg.materialsDir, legacyPath) : undefined;
        const archived = await regularFile(this.cfg.materialsDir, version.relativePath);
        if (legacy && archived && await fileHash(legacy) === await fileHash(archived)) {
          await unlink(legacy); await pruneEmpty(this.cfg.materialsDir, legacy);
        }
        continue;
      }
      const old = await regularFile(this.cfg.materialsDir, version.relativePath);
      if (!old) continue;
      const nextPath = '.history/' + version.relativePath;
      await safeDirectory(this.cfg.materialsDir, dirname(nextPath));
      const destination = join(this.cfg.materialsDir, nextPath);
      const existing = await regularFile(this.cfg.materialsDir, nextPath);
      if (existing) {
        if (await fileHash(existing) !== await fileHash(old)) throw new MoodleError('LOCAL_IO');
      } else await link(old, destination);
      const changed: StoredFile = { ...record, versions: record.versions.map((v, n) => n === i ? { ...v, relativePath: nextPath } : v) };
      await this.commitRecord(file.key, changed, state);
      record = changed;
      await unlink(old); await pruneEmpty(this.cfg.materialsDir, old);
    }
    return publishLatest(this.cfg, file, state, record => this.commitRecord(file.key, record, state));
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
  async run(options: { courseIds?: number[]; moduleId?: number; force?: boolean; mode?: 'full' | 'quick' | 'organize' } = {}): Promise<SyncSummary> {
    requireSetup(this.cfg);
    if (options.mode !== undefined && options.mode !== 'full' && options.force) throw new MoodleError('INVALID_INPUT');
    const ids = options.courseIds ?? this.cfg.courses.map(c => c.id); ids.forEach(id => approvedCourse(id, this.cfg.courses));
    if (!ids.length || new Set(ids).size !== ids.length) throw new MoodleError('INVALID_INPUT');
    await privateDirectory(this.cfg.dataDir); await privateDirectory(this.cfg.stateDir); await privateDirectory(this.cfg.materialsDir);
    const state = await this.load();
    const summary: SyncSummary = { added: [], updated: [], unchanged: [], failed: [], skipped: [], remoteMissing: [], needsLogin: false };
    for (const courseId of ids) {
      let complete = options.moduleId === undefined && (options.mode === undefined || options.mode === 'full'); const seen = new Set<string>();
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
          let files: RemoteFile[];
          try { files = await this.backend.listFiles(resource); }
          catch (e) {
            complete = false; const f = failure(e, 'discovery'); summary.failed.push({ courseId, moduleId: resource.moduleId, ...f });
            if (this.stop(f.code, summary)) return summary; continue;
          }
          for (const file of files) {
            seen.add(file.key);
            try {
              const route = routeFile(this.cfg, file, state.files[file.key]);
              if (route.reason) {
                summary.skipped.push({ courseId, moduleId: resource.moduleId, title: resource.title, reason: route.reason });
                complete = false; continue;
              }
              if (route.directory) await checkRouteDirectory(route.root, route.directory);
              const previous = state.files[file.key];
              const previousReadable = previous?.readablePath && (previous.readableRoot ?? this.cfg.materialsDir) === route.root ? await regularFile(route.root, previous.readablePath) : undefined;
              if (previousReadable && previous?.readableHash && await fileHash(previousReadable) !== previous.readableHash) {
                summary.skipped.push({ courseId, moduleId: resource.moduleId, title: resource.title, reason: '保留用户修改的课件；远端版本使用独立可读文件' });
              }
              await this.organize(file, state);
              if (options.mode === 'organize' || (options.mode === 'quick' && state.files[file.key])) {
                summary.skipped.push({ courseId, moduleId: resource.moduleId, title: resource.title, reason: options.mode === 'organize' ? '仅整理本地资料：未下载或检查远端内容' : '快速模式：已有文件未检查远端内容更新' }); continue;
              }
              await this.processFile(file, state, summary, options.force ?? false);
              const readable = await this.organize(file, state);
              if (readable) for (const list of [summary.added, summary.updated, summary.unchanged]) {
                const entry = list.find(e => e.key === file.key); if (entry) entry.path = readable;
              }
            }
            catch (e) {
              summary.added = summary.added.filter(entry => entry.key !== file.key);
              summary.updated = summary.updated.filter(entry => entry.key !== file.key);
              summary.unchanged = summary.unchanged.filter(entry => entry.key !== file.key);
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
