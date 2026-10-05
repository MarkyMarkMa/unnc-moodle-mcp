import { constants } from 'node:fs';
import { copyFile, link, unlink, rmdir, rename, readdir } from 'node:fs/promises';
import { dirname, join, relative, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contained } from './platform.js';
import type { Config } from './config.js';
import { MoodleError, type Manifest, type RemoteFile, type StoredFile } from './model.js';
import { fileHash, regularFile, safeDirectory, safeFilename } from './safety.js';

export async function pruneEmpty(root: string, file: string): Promise<void> {
  let dir = dirname(file);
  while (dir !== root && contained(root, dir)) {
    try { await rmdir(dir); } catch (e) {
      if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((e as NodeJS.ErrnoException).code ?? '')) return;
      throw e;
    }
    dir = dirname(dir);
  }
}

// Latest files are independent copies (copy-on-write on supported filesystems),
// so annotations cannot change immutable history. Only owned, unedited paths
// may be replaced or removed. IDs remain in metadata and hidden history.
export async function publishLatest(cfg: Config, file: RemoteFile, state: Manifest,
  commit: (record: StoredFile) => Promise<void>): Promise<string | undefined> {
  const record = state.files[file.key];
  if (!record) return;
  const latest = record.versions.at(-1)!;
  const source = await regularFile(cfg.materialsDir, latest.relativePath);
  if (!source || await fileHash(source) !== latest.sha256) return;
  const reserved = new Set(cfg.courses.map(c => safeFilename(c.name).toLocaleLowerCase()));
  const assigned = new Set<string>();
  let course = '';
  for (const c of [...cfg.courses].sort((a, b) => a.id - b.id)) {
    const base = safeFilename(c.name);
    let name = base;
    for (let n = 2; assigned.has(name.toLocaleLowerCase()); n++) {
      let prefix = base;
      const suffix = ` (${n})`;
      while (Buffer.byteLength(prefix + suffix) > 175) prefix = prefix.slice(0, -1);
      name = prefix + suffix;
      while (reserved.has(name.toLocaleLowerCase()) || assigned.has(name.toLocaleLowerCase())) {
        n++; name = prefix + ` (${n})`;
      }
    }
    assigned.add(name.toLocaleLowerCase());
    if (c.id === file.courseId) course = name;
  }
  const parts = [course, safeFilename(file.sectionName || 'General')];
  if (file.relativeFolder !== undefined) {
    parts.push(safeFilename(file.title));
    for (const part of file.relativeFolder.split('/').filter(Boolean)) parts.push(safeFilename(part));
  }
  const dir = await safeDirectory(cfg.materialsDir, parts.join('/'));
  const old = record.readablePath ? await regularFile(cfg.materialsDir, record.readablePath) : undefined;
  const owned = !!old && !!record.readableHash && await fileHash(old) === record.readableHash;
  const preferred = join(dir, latest.filename);
  let destination = preferred;
  // Reuse the previous collision name when it still belongs in this folder.
  if (old && owned && dirname(old) === dir && record.readableFilename === latest.filename) destination = old;
  const stem = parse(latest.filename);
  for (let n = 2; ; n++) {
    const existing = await regularFile(cfg.materialsDir, relative(cfg.materialsDir, destination).split('\\').join('/'));
    const caseConflict = (await readdir(dir)).some(name => name.toLocaleLowerCase() === parse(destination).base.toLocaleLowerCase() && name !== parse(destination).base);
    const claimed = caseConflict || Object.values(state.files).some(f => f.key !== file.key && f.readablePath?.toLocaleLowerCase() === relative(cfg.materialsDir, destination).split('\\').join('/').toLocaleLowerCase());
    if (!claimed && (!existing || (owned && existing === old))) break;
    let prefix = stem.name;
    const suffix = ` (${n})${stem.ext}`;
    while (Buffer.byteLength(prefix + suffix) > 175) prefix = prefix.slice(0, -1);
    destination = join(dir, safeFilename(prefix + suffix));
  }
  if (old === destination && owned && record.readableHash === latest.sha256) return destination;
  const temporary = join(dir, '.moodle-' + randomUUID() + '.tmp');
  const backup = join(dir, '.moodle-' + randomUUID() + '.backup');
  let backedUp = false;
  let published = false;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    if (await fileHash(temporary) !== latest.sha256) throw new MoodleError('LOCAL_IO');
    // Publish without clobbering an unrelated file, including files created
    // during copy. For updates, detach the old inode only after validation.
    if (old === destination && owned) {
      if (await fileHash(old) !== record.readableHash) throw new MoodleError('LOCAL_IO');
      await link(old, backup); backedUp = true;
      await rename(temporary, destination);
    } else await link(temporary, destination);
    published = true;
    const changed = { ...record, readablePath: relative(cfg.materialsDir, destination).split('\\').join('/'), readableHash: latest.sha256, readableFilename: latest.filename };
    try { await commit(changed); }
    catch (e) {
      if (backedUp) { await rename(backup, destination); backedUp = false; }
      else await unlink(destination);
      published = false;
      throw e;
    }
    if (old && owned && old !== destination && await fileHash(old) === record.readableHash) {
      await unlink(old); await pruneEmpty(cfg.materialsDir, old);
    }
    return destination;
  } catch (e) {
    if (backedUp && !published) { await rename(backup, destination); backedUp = false; }
    throw e;
  } finally {
    await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (backedUp) await unlink(backup);
  }
}
