import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, loadCourses, type Config } from '../src/config.js';
import { MoodleService } from '../src/service.js';
import { selectCourses, confirmSetup, writePrivateJson } from '../src/setup.js';
import { MoodleError, type Backend } from '../src/model.js';

test('setup gates downloads, validates observed selection and preserves history when clearing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodle-setup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cfg: Config = { ...config(), settingsFile: join(root, 'settings.json'), coursesFile: join(root, 'courses.json'), dataDir: root, stateDir: join(root, 'state'), materialsDir: join(root, 'materials'), courses: [], setupConfirmed: false };
  let discovered = 0;
  const backend = { listCourses: async () => { discovered++; return [{ id: 808, name: 'Observed course', selected: false }, { id: 909, name: 'New course', selected: false }]; }, close: async () => {} } as unknown as Backend;
  const service = new MoodleService(cfg, () => backend);
  assert.throws(() => service.sync(), (e: unknown) => e instanceof MoodleError && e.code === 'SETUP_REQUIRED');
  await assert.rejects(confirmSetup(service, root));
  await assert.rejects(selectCourses(service, [999]));
  assert.deepEqual(cfg.courses, []);
  await selectCourses(service, [808]);
  assert.equal(loadCourses(cfg.coursesFile)[0]?.name, 'Observed course');
  await assert.rejects(confirmSetup(service, join(root, 'other')));
  await confirmSetup(service, root);
  assert.equal(cfg.setupConfirmed, true);
  const saved = JSON.parse(await readFile(cfg.settingsFile, 'utf8'));
  assert.equal(saved.dataDir, root);
  const sentinel = join(cfg.stateDir, 'history-kept.json'); await writeFile(sentinel, '{}');
  await selectCourses(service, [909], 'add');
  assert.deepEqual((cfg.courses as Array<{id:number}>).map(c => c.id), [808, 909]);
  await selectCourses(service, [909], 'add');
  assert.deepEqual((cfg.courses as Array<{id:number}>).map(c => c.id), [808, 909]);
  await assert.rejects(selectCourses(service, [999], 'add'));
  assert.deepEqual((cfg.courses as Array<{id:number}>).map(c => c.id), [808, 909]);
  const beforeClear = discovered; await selectCourses(service, []);
  assert.equal(discovered, beforeClear); assert.deepEqual(loadCourses(cfg.coursesFile), []);
  assert.equal(await readFile(sentinel, 'utf8'), '{}');
  assert.equal(service.status().readyToSync, false);
  assert.throws(() => service.sync(), (e: unknown) => e instanceof MoodleError && e.code === 'SETUP_REQUIRED');
});

test('setup atomic writes refuse symlinks and clean temporary files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodle-settings-')); t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'outside.json'); await writeFile(target, 'unchanged');
  const path = join(root, 'settings.json'); await symlink(target, path);
  await assert.rejects(writePrivateJson(path, {}));
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  assert.equal((await readdir(root)).some(f => f.endsWith('.tmp')), false);
});


test('confirmed custom root and external course file survive restart; root overrides require new confirmation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodle-restart-')); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = join(root, 'settings.json'); const data = join(root, 'custom-data'); const courses = join(root, 'external-courses.json');
  await writePrivateJson(courses, [{ id: 808, name: 'Observed course' }]);
  await writePrivateJson(settings, { schemaVersion: 1, confirmed: true, dataDir: data, coursesFile: courses });
  const env: NodeJS.ProcessEnv = { ...process.env, MOODLE_SETTINGS_FILE: settings };
  delete env.MOODLE_DATA_DIR; delete env.MOODLE_COURSES_FILE;
  const modulePath = fileURLToPath(new URL('../src/config.js', import.meta.url));
  const script = `import { config } from ${JSON.stringify(new URL('file://' + modulePath).href)}; console.log(JSON.stringify(config()));`;
  const restarted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }));
  assert.equal(restarted.dataDir, data); assert.equal(restarted.coursesFile, courses); assert.equal(restarted.setupConfirmed, true);
  assert.equal(restarted.courses[0].id, 808);
  const other = join(root, 'other-data');
  const changed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, MOODLE_DATA_DIR: other }, encoding: 'utf8' }));
  assert.equal(changed.setupConfirmed, false); assert.equal(changed.coursesFile, join(other, '_moodle', 'courses.json')); assert.deepEqual(changed.courses, []);
  for (const reserved of [join(data, 'state', 'manifest.json'), join(data, 'materials', 'config.json')]) {
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, MOODLE_COURSES_FILE: reserved }, stdio: 'pipe' }));
  }
  const collisionEnv = { ...env, MOODLE_COURSES_FILE: settings };
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: collisionEnv, stdio: 'pipe' }));
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).confirmed, true);
  const malformed = join(root, 'bad-settings.json'); await writeFile(malformed, '{broken');
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, MOODLE_SETTINGS_FILE: malformed }, stdio: 'pipe' }));
  const alias = join(root, 'alias-settings.json'); await symlink(settings, alias);
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, MOODLE_SETTINGS_FILE: alias }, stdio: 'pipe' }));
});

test('login holds operation lock, verifies authentication, and releases lock on cancellation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodle-login-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cfg: Config = { ...config(), stateDir: join(root, 'state'), courses: [] };
  let authenticated = false; let checks = 0;
  const backend = { checkConnection: async () => { checks++; return { connected: true, authenticated, needsLogin: !authenticated }; }, close: async () => {} } as Backend;
  const service = new MoodleService(cfg, () => backend);
  let finish!: () => void;
  const pending = service.login(() => new Promise<void>(resolve => { finish = resolve; }));
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(service.check(), (e: unknown) => e instanceof MoodleError && e.code === 'BUSY');
  assert.equal(checks, 0); authenticated = true; finish();
  assert.equal((await pending).authenticated, true);
  authenticated = false;
  assert.equal((await service.login(async () => {})).needsLogin, true);
  await assert.rejects(service.login(async () => { throw new MoodleError('NEEDS_LOGIN'); }));
  assert.equal((await service.check()).authenticated, false);
  assert.deepEqual(cfg.courses, []);
});
