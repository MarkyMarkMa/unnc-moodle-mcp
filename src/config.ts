import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { MoodleError, type SelectedCourse } from './model.js';

export interface Config {
  settingsFile: string; setupConfirmed: boolean;
  courses: SelectedCourse[]; coursesFile: string; profileDir: string; dataDir: string; materialsDir: string; stateDir: string;
  headless: boolean; requestIntervalMs: number; timeoutMs: number; maxBytes: number;
}
export function config(): Config {
  const settingsFile = process.env.MOODLE_SETTINGS_FILE ?? join(homedir(), 'Library', 'Application Support', 'moodle-mcp', 'settings.json');
  if (!isAbsolute(settingsFile)) throw new MoodleError('INVALID_INPUT');
  const settings = loadSettings(settingsFile);
  const dataDir = process.env.MOODLE_DATA_DIR ?? settings?.dataDir ?? join(homedir(), 'Documents', 'MoodleSync');
  const profileDir = process.env.MOODLE_PROFILE_DIR ?? join(homedir(), 'Library', 'Application Support', 'moodle-mcp', 'browser-profile');
  const coursesFile = process.env.MOODLE_COURSES_FILE ?? (settings?.dataDir === resolve(dataDir) ? settings.coursesFile : undefined) ?? join(dataDir, 'courses.json');
  if (![dataDir, profileDir, coursesFile, settingsFile].every(isAbsolute)) throw new MoodleError('INVALID_INPUT');
  if (resolve(settingsFile) === resolve(coursesFile)) throw new MoodleError('INVALID_INPUT');
  const reservedDirectories = [profileDir, join(dataDir, 'materials'), join(dataDir, 'state')].map(p => resolve(p));
  if ([settingsFile, coursesFile].some(p => reservedDirectories.some(root => resolve(p) === root || resolve(p).startsWith(root + '/')))) throw new MoodleError('INVALID_INPUT');
  if (resolve(dataDir) === resolve(profileDir) || resolve(profileDir).startsWith(resolve(dataDir) + '/')) throw new MoodleError('INVALID_INPUT');
  return { settingsFile, setupConfirmed: settings?.dataDir === resolve(dataDir) && settings?.coursesFile === resolve(coursesFile), courses: loadCourses(coursesFile), coursesFile, dataDir, profileDir, materialsDir: join(dataDir, 'materials'), stateDir: join(dataDir, 'state'),
    headless: process.env.MOODLE_HEADLESS !== 'false', requestIntervalMs: 1500, timeoutMs: 30000, maxBytes: 100 * 1024 * 1024 };
}
export function requireSetup(cfg: Config): void {
  if (!cfg.setupConfirmed || !cfg.courses.length) throw new MoodleError('SETUP_REQUIRED');
}
function loadSettings(path: string): { dataDir: string; coursesFile: string } | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) throw new Error();
    const v = JSON.parse(readFileSync(path, 'utf8'));
    if (v.schemaVersion !== 1 || v.confirmed !== true || typeof v.dataDir !== 'string' || !isAbsolute(v.dataDir) || typeof v.coursesFile !== 'string' || !isAbsolute(v.coursesFile)) throw new Error();
    return { dataDir: resolve(v.dataDir), coursesFile: resolve(v.coursesFile) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new MoodleError('INVALID_INPUT');
  }
}
export function approvedCourse(id: number, courses: readonly SelectedCourse[]): void {
  if (!Number.isSafeInteger(id) || !courses.some(c => c.id === id)) throw new MoodleError('INVALID_INPUT');
}

export function loadCourses(path: string): SelectedCourse[] {
  try {
    const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) throw new Error();
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(value) || value.length > 200) throw new Error();
    const ids = new Set<number>();
    return value.map(c => {
      if (!c || typeof c !== 'object' || !Number.isSafeInteger(c.id) || c.id <= 0 || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 500 || ids.has(c.id)) throw new Error();
      ids.add(c.id); return { id: c.id, name: c.name.trim() };
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new MoodleError('INVALID_INPUT');
  }
}
