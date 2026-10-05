import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, basename, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MoodleService } from './service.js';
import { MoodleError } from './model.js';
import { privateDirectory, regularFile } from './safety.js';

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  await regularFile(dirname(path), basename(path));
  const temporary = path + '.' + randomUUID() + '.tmp';
  const h = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(JSON.stringify(value, null, 2) + '\n'); await h.sync(); await h.close(); await rename(temporary, path); }
  finally { await h.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
export async function selectCourses(service: MoodleService, ids: number[], mode: 'replace' | 'add' = 'replace'): Promise<unknown> {
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length || ids.length > 200) throw new MoodleError('INVALID_INPUT');
  return service.withBackend(async backend => {
    const available = ids.length ? await backend.listCourses() : [];
    const observed = ids.map(id => {
      const c = available.find(c => c.id === id);
      if (!c) throw new MoodleError('INVALID_INPUT');
      return { id: c.id, name: c.name };
    });
    const selected = mode === 'add' ? [...new Map([...service.cfg.courses, ...observed].map(c => [c.id, c])).values()] : observed;
    if (selected.length > 200) throw new MoodleError('INVALID_INPUT');
    await writePrivateJson(service.cfg.coursesFile, selected);
    service.cfg.courses = selected;
    return { selectedCourses: selected, restartMcpRequired: false, historicalFilesRetained: true };
  });
}
export async function confirmSetup(service: MoodleService, dataDir: string): Promise<unknown> {
  if (!isAbsolute(dataDir) || resolve(dataDir) !== resolve(service.cfg.dataDir) || !service.cfg.courses.length) throw new MoodleError('INVALID_INPUT');
  return service.withBackend(async () => {
    await writePrivateJson(service.cfg.settingsFile, { schemaVersion: 1, confirmed: true, dataDir: resolve(service.cfg.dataDir), coursesFile: resolve(service.cfg.coursesFile) });
    service.cfg.setupConfirmed = true;
    return service.status();
  });
}
