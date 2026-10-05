import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { migrateStorage } from '../src/storage.js';
import { MoodleError } from '../src/model.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'moodle-storage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'state')); writeFileSync(join(root, 'state', 'manifest.json'), '{"schemaVersion":1,"files":{}}');
  writeFileSync(join(root, 'courses.json'), '[{"id":808,"name":"Example course"}]');
  mkdirSync(join(root, 'materials')); writeFileSync(join(root, 'materials', 'notes.txt'), 'annotation');
  mkdirSync(join(root, '升级备份-20260101-123456')); writeFileSync(join(root, '升级备份-20260101-123456', 'sentinel'), 'backup');
  return root;
}
const errorCode = (code: string) => (e: unknown) => e instanceof MoodleError && e.code === code;

test('legacy migration keeps manifest, annotations and backups, and is idempotent', t => {
  const root = fixture(t); let saved = '';
  migrateStorage(root, true, path => { saved = path; });
  assert.equal(saved, join(root, '_moodle', 'courses.json'));
  assert.deepEqual(readdirSync(root).sort(), ['_moodle', 'materials']);
  assert.equal(readFileSync(join(root, 'materials', 'notes.txt'), 'utf8'), 'annotation');
  assert.equal(readFileSync(join(root, '_moodle', '升级备份-20260101-123456', 'sentinel'), 'utf8'), 'backup');
  assert.equal(readFileSync(join(root, '_moodle', 'state', 'manifest.json'), 'utf8'), '{"schemaVersion":1,"files":{}}');
  migrateStorage(root, true); assert.equal(existsSync(join(root, '.moodle-storage.lock')), false);
});

test('migration refuses conflicts, symlinks, operations and interrupted markers before moving files', t => {
  for (const scenario of ['conflict', 'symlink', 'legacy-lock', 'new-lock', 'marker']) {
    const root = fixture(t); mkdirSync(join(root, '_moodle'));
    if (scenario === 'conflict') mkdirSync(join(root, '_moodle', 'state'));
    if (scenario === 'symlink') { rmSync(join(root, '_moodle'), { recursive: true }); symlinkSync(join(root, 'materials'), join(root, '_moodle'), process.platform === 'win32' ? 'junction' : 'dir'); }
    if (scenario === 'legacy-lock') writeFileSync(join(root, 'state', 'operation.lock'), 'busy');
    if (scenario === 'new-lock') { mkdirSync(join(root, '_moodle', 'state')); writeFileSync(join(root, '_moodle', 'state', 'operation.lock'), 'busy'); }
    if (scenario === 'marker') writeFileSync(join(root, '.moodle-storage.lock'), 'interrupted');
    assert.throws(() => migrateStorage(root, true), errorCode(scenario === 'conflict' ? 'STORAGE_CONFLICT' : scenario === 'symlink' ? 'PATH_UNSAFE' : 'BUSY'));
    assert.equal(existsSync(join(root, 'courses.json')), true); assert.equal(existsSync(join(root, 'state', 'manifest.json')), true);
  }
});

test('move/settings failures roll back; explicit files and unrelated folders stay put', t => {
  for (const phase of ['move', 'settings']) {
    const root = fixture(t); let calls = 0;
    assert.throws(() => migrateStorage(root, true, () => { if (phase === 'settings') throw Object.assign(new Error('disk'), { code: 'EIO' }); }, (from, to) => {
      if (phase === 'move' && ++calls === 2) throw Object.assign(new Error('disk'), { code: 'EIO' });
      renameSync(from, to);
    }), errorCode('LOCAL_IO'));
    assert.equal(existsSync(join(root, 'courses.json')), true); assert.equal(existsSync(join(root, 'state', 'manifest.json')), true);
    assert.equal(existsSync(join(root, '升级备份-20260101-123456', 'sentinel')), true);
    assert.equal(existsSync(join(root, '.moodle-storage.lock')), false); assert.deepEqual(readdirSync(join(root, '_moodle')), []);
  }
  const root = fixture(t); mkdirSync(join(root, 'my-backup'));
  migrateStorage(root, false); assert.equal(existsSync(join(root, 'courses.json')), true); assert.equal(existsSync(join(root, 'my-backup')), true);
});

test('config restart preserves confirmed selection and explicit overrides', t => {
  const root = fixture(t); const settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify({ schemaVersion: 1, confirmed: true, dataDir: root, coursesFile: join(root, 'courses.json') }));
  const script = `import { config } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}; console.log(JSON.stringify(config()));`;
  const env: NodeJS.ProcessEnv = { ...process.env, MOODLE_SETTINGS_FILE: settings, MOODLE_DATA_DIR: root }; delete env.MOODLE_COURSES_FILE;
  const run = (e = env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: e, encoding: 'utf8' }));
  const cfg = run(); assert.equal(cfg.setupConfirmed, true); assert.equal(cfg.courses[0].id, 808);
  assert.equal(cfg.stateDir, join(root, '_moodle', 'state')); assert.equal(cfg.coursesFile, join(root, '_moodle', 'courses.json'));
  assert.deepEqual(run(), cfg); assert.equal(JSON.parse(readFileSync(settings, 'utf8')).coursesFile, cfg.coursesFile);
  const other = fixture(t); const external = join(other, 'courses.json');
  const custom = run({ ...env, MOODLE_DATA_DIR: other, MOODLE_COURSES_FILE: external });
  assert.equal(custom.coursesFile, external); assert.equal(existsSync(external), true); assert.equal(custom.setupConfirmed, false);
});

test('updater selects migrated lock path and rejects old/new locks and migration markers', t => {
  const root = fixture(t);
  const script = `import { dataLockPath } from ${JSON.stringify(new URL('../../scripts/update.mjs', import.meta.url).href)}; console.log(await dataLockPath());`;
  const env = { ...process.env, MOODLE_DATA_DIR: root, MOODLE_SETTINGS_FILE: join(root, 'absent-settings.json') };
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', stdio: 'pipe' }).trim();
  assert.equal(run(), join(root, 'state', 'operation.lock'));
  migrateStorage(root, true);
  assert.equal(run(), join(root, '_moodle', 'state', 'operation.lock'));
  for (const path of [join(root, '_moodle', 'state', 'operation.lock'), join(root, '.moodle-storage.lock')]) {
    writeFileSync(path, 'busy'); assert.throws(run); rmSync(path);
  }
  mkdirSync(join(root, 'state')); const legacy = join(root, 'state', 'operation.lock');
  writeFileSync(legacy, 'busy'); assert.throws(run);
});

test('failed rollback retains both entries and an interruption marker instead of overwriting', t => {
  const root = fixture(t); let first = true; let moved = '';
  assert.throws(() => migrateStorage(root, true, undefined, (from, to) => {
    if (!first) throw Object.assign(new Error('disk'), { code: 'EIO' });
    first = false; moved = String(from); renameSync(from, to);
    // Another writer creates the original name after the move.
    writeFileSync(from, 'must not overwrite');
  }), errorCode('STORAGE_CONFLICT'));
  assert.equal(readFileSync(moved, 'utf8'), 'must not overwrite');
  assert.equal(existsSync(join(root, '_moodle', moved.split(/[/\\]/).at(-1)!)), true);
  assert.equal(existsSync(join(root, '.moodle-storage.lock')), true);
  assert.throws(() => migrateStorage(root, true), errorCode('BUSY'));
});
