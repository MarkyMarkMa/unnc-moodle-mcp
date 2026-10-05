import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { applicationDirectory, browserProfileName, contained } from './platform.js';
import { migrateStorage, saveMigratedSettings } from './storage.js';
import { MoodleError, type SelectedCourse } from './model.js';

export interface Config {
  settingsFile: string; setupConfirmed: boolean;
  courses: SelectedCourse[]; coursesFile: string; profileDir: string; dataDir: string; materialsDir: string; stateDir: string;
  headless: boolean; requestIntervalMs: number; timeoutMs: number; maxBytes: number;
}
export function config(): Config {
  const settingsFile = process.env.MOODLE_SETTINGS_FILE ?? join(applicationDirectory(), 'settings.json');
  if (!isAbsolute(settingsFile)) throw new MoodleError('INVALID_INPUT');
  let settings = loadSettings(settingsFile);
  const dataDir = process.env.MOODLE_DATA_DIR ?? settings?.dataDir ?? join(homedir(), 'Documents', 'MoodleSync');
  const profileDir = process.env.MOODLE_PROFILE_DIR ?? join(applicationDirectory(), browserProfileName());
  let coursesFile = process.env.MOODLE_COURSES_FILE ?? (settings?.dataDir === resolve(dataDir) ? settings.coursesFile : undefined) ?? join(dataDir, '_moodle', 'courses.json');
  if (![dataDir, profileDir, coursesFile, settingsFile].every(isAbsolute)) throw new MoodleError('INVALID_INPUT');
  if (contained(settingsFile, coursesFile) && contained(coursesFile, settingsFile)) throw new MoodleError('INVALID_INPUT');
  const reservedDirectories = [profileDir, join(dataDir, 'materials'), join(dataDir, 'state'), join(dataDir, '_moodle', 'state')].map(p => resolve(p));
  if ([settingsFile, coursesFile].some(p => reservedDirectories.some(root => contained(root, p)))) throw new MoodleError('INVALID_INPUT');
  if (contained(dataDir, profileDir)) throw new MoodleError('INVALID_INPUT');
  const legacyCourses = join(resolve(dataDir), 'courses.json');
  const moveCourses = !process.env.MOODLE_COURSES_FILE && (coursesFile === legacyCourses || coursesFile === join(dataDir, '_moodle', 'courses.json'));
  // Validate the old selection before moving anything; explicit external files stay put.
  if (moveCourses) loadCourses(legacyCourses);
  migrateStorage(dataDir, moveCourses, settings?.dataDir === resolve(dataDir) && settings.coursesFile === legacyCourses ? next => {
    saveMigratedSettings(settingsFile, { schemaVersion: 1, confirmed: true, dataDir: settings!.dataDir, coursesFile: next });
  } : undefined);
  if (moveCourses) coursesFile = join(resolve(dataDir), '_moodle', 'courses.json');
  settings = loadSettings(settingsFile);
  return { settingsFile, setupConfirmed: settings?.dataDir === resolve(dataDir) && settings?.coursesFile === resolve(coursesFile), courses: loadCourses(coursesFile), coursesFile, dataDir, profileDir, materialsDir: join(dataDir, 'materials'), stateDir: join(dataDir, '_moodle', 'state'),
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
