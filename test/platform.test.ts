import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { applicationDirectory, browserChannel, browserName, browserProfileName, sessionModeUnsafe, contained } from '../src/platform.js';
import { mkdtemp, mkdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pruneEmpty } from '../src/layout.js';
import { safeFilename } from '../src/safety.js';

test('Windows application data uses LocalAppData and never macOS directories', () => {
  assert.equal(applicationDirectory('win32', 'C:\\Users\\USER', { LOCALAPPDATA: 'D:\\App Data' }), 'D:\\App Data\\moodle-mcp');
  assert.equal(applicationDirectory('win32', 'C:\\Users\\USER', {}), 'C:\\Users\\USER\\AppData\\Local\\moodle-mcp');
  assert.equal(applicationDirectory('darwin', '/home/USER/', {}), '/home/USER/Library/Application Support/moodle-mcp');
});
test('directory boundaries reject siblings and parent escapes', () => {
  const root = resolve('test-root');
  assert.equal(contained(root, join(root, 'state', 'settings.json')), true);
  assert.equal(contained(root, root), true);
  assert.equal(contained(root, root + '-sibling'), false);
  assert.equal(contained(root, join(root, '..', 'outside')), false);
  if (process.platform === 'win32') {
    assert.equal(contained('C:\\DATA', 'c:\\data\\state'), true);
    assert.equal(contained('C:\\DATA', 'D:\\DATA\\state'), false);
  }
});
test('Windows reserved filenames and trailing dots stay writable', () => {
  for (const value of ['CON', 'nul.pdf', 'LPT1.txt', 'AUX']) assert.ok(safeFilename(value).startsWith('_'));
  assert.equal(safeFilename('Lecture. '), 'Lecture');
  assert.equal(safeFilename('A:B?.pdf'), 'A_B_.pdf');
});

test('empty-directory pruning stops at the materials root and does not touch siblings', async t => {
  const base = await mkdtemp(join(tmpdir(), 'moodle-platform-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'materials'), nested = join(root, 'course', 'section');
  const sibling = root + '-notes';
  await mkdir(nested, { recursive: true }); await mkdir(sibling);
  await pruneEmpty(root, join(nested, 'removed.pdf'));
  await assert.rejects(lstat(join(root, 'course')), { code: 'ENOENT' });
  assert.ok((await lstat(root)).isDirectory());
  await pruneEmpty(root, join(sibling, 'removed.pdf'));
  assert.ok((await lstat(sibling)).isDirectory());
});

test('Windows uses Edge with an isolated profile; macOS retains Chrome and its profile', () => {
  assert.equal(browserChannel('win32'), 'msedge');
  assert.equal(browserName('win32'), 'Microsoft Edge');
  assert.equal(browserProfileName('win32'), 'edge-profile');
  assert.equal(browserChannel('darwin'), 'chrome');
  assert.equal(browserName('darwin'), 'Google Chrome');
  assert.equal(browserProfileName('darwin'), 'browser-profile');
});

test('session mode validation respects POSIX and Windows ACL semantics', () => {
  assert.equal(sessionModeUnsafe(0o600, 'darwin'), false);
  assert.equal(sessionModeUnsafe(0o644, 'darwin'), true);
  assert.equal(sessionModeUnsafe(0o666, 'win32'), false);
});
