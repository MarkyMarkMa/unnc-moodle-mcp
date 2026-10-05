import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MoodleError, atStage } from './model.js';

function stat(path: string) {
  try { return lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
function directory(path: string): void {
  const s = stat(path);
  if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new MoodleError('PATH_UNSAFE');
}

// Runs before constructing a service. Stop all older MCP processes before upgrading:
// older binaries do not know the new lock path. Never merge competing state trees.
export function migrateStorage(dataDir: string, moveCourses: boolean, saveSettings?: (coursesFile: string) => void,
  move: typeof renameSync = renameSync): void {
  directory(dataDir);
  if (!stat(dataDir)) return;
  const management = join(dataDir, '_moodle');
  directory(management);
  const lock = join(dataDir, '.moodle-storage.lock');
  if (stat(lock) || stat(join(dataDir, 'state', 'operation.lock')) || stat(join(management, 'state', 'operation.lock'))) throw new MoodleError('BUSY');
  const names = readdirSync(dataDir).filter(name => name === 'state' || (moveCourses && name === 'courses.json') || /^升级备份-\d{8}-\d{6}$/.test(name));
  if (!names.length) return;
  for (const name of names) {
    const source = stat(join(dataDir, name))!;
    if (source.isSymbolicLink() || (name === 'courses.json' ? !source.isFile() : !source.isDirectory())) throw new MoodleError('PATH_UNSAFE');
    if (stat(join(management, name))) throw new MoodleError('STORAGE_CONFLICT');
  }
  let handle: number;
  try { handle = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new MoodleError('BUSY'); throw e; }
  closeSync(handle);
  const moved: string[] = [];
  let recovered = true;
  try {
    if (!stat(management)) mkdirSync(management, { mode: 0o700 });
    for (const name of names) {
      if (stat(join(management, name))) throw new MoodleError('STORAGE_CONFLICT');
      move(join(dataDir, name), join(management, name)); moved.push(name);
    }
    if (moved.includes('courses.json')) saveSettings?.(join(management, 'courses.json'));
  } catch (error) {
    try {
      for (const name of moved.reverse()) {
        if (stat(join(dataDir, name))) throw new MoodleError('STORAGE_CONFLICT');
        renameSync(join(management, name), join(dataDir, name));
      }
    }
    catch { recovered = false; throw new MoodleError('STORAGE_CONFLICT'); }
    throw atStage(error, 'local');
  } finally {
    // An interrupted/failed rollback leaves the marker; recovery must be manual.
    if (recovered) unlinkSync(lock);
  }
}

export function saveMigratedSettings(path: string, value: unknown): void {
  const temporary = path + '.' + randomUUID() + '.tmp';
  let handle: number | undefined;
  try {
    handle = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(handle, JSON.stringify(value, null, 2) + '\n'); fsyncSync(handle); closeSync(handle); handle = undefined;
    renameSync(temporary, path);
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (stat(temporary)) unlinkSync(temporary);
  }
}
