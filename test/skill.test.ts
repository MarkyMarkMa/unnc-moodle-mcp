import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-ignore Standalone installer works before npm install/build.
import { installSkill, skillDestination } from '../../scripts/install-skill.mjs';
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodle-skill-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'bundled.md'); await writeFile(source, '---\nname: unnc-moodle\n---\nSynthetic instructions\n');
  return { root, source, env: {} };
}

test('skill installer selects user/custom/legacy paths and installs idempotently', async t => {
  const f = await fixture(t); const options = { home: f.root, source: f.source, env: f.env };
  const installed = await installSkill(options);
  assert.equal(installed.destination, join(f.root, '.agents', 'skills', 'unnc-moodle'));
  assert.equal(installed.installed, true);
  assert.equal(await readFile(join(installed.destination, 'SKILL.md'), 'utf8'), await readFile(f.source, 'utf8'));
  assert.equal((await installSkill(options)).installed, false);
  assert.deepEqual(await readdir(join(f.root, '.agents', 'skills')), ['unnc-moodle']);
  const custom = await installSkill({ ...options, env: { CODEX_HOME: join(f.root, 'custom codex') } });
  assert.equal(custom.destination, join(f.root, 'custom codex', 'skills', 'unnc-moodle'));
  await assert.rejects(skillDestination({ home: f.root, env: { CODEX_HOME: 'relative' } }), /absolute/);
  const other = await fixture(t); const legacy = join(other.root, '.codex', 'skills', 'unnc-moodle');
  await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, 'SKILL.md'), await readFile(other.source));
  assert.equal((await installSkill({ home: other.root, source: other.source, env: {} })).destination, legacy);
  await mkdir(join(other.root, '.agents', 'skills', 'unnc-moodle'), { recursive: true });
  await assert.rejects(skillDestination({ home: other.root, env: {} }), /Duplicate/);
});

test('skill installer preserves differing/incomplete skills and refuses links and occupied lock', async t => {
  const f = await fixture(t); const options = { home: f.root, source: f.source, env: f.env };
  const destination = (await installSkill(options)).destination;
  await writeFile(join(destination, 'SKILL.md'), 'USER MODIFICATIONS');
  await writeFile(join(destination, 'notes.txt'), 'KEEP NOTES');
  await assert.rejects(installSkill(options), /not overwritten/);
  assert.equal(await readFile(join(destination, 'SKILL.md'), 'utf8'), 'USER MODIFICATIONS');
  assert.equal(await readFile(join(destination, 'notes.txt'), 'utf8'), 'KEEP NOTES');
  await rm(join(destination, 'SKILL.md'));
  await assert.rejects(installSkill(options), /incomplete/);
  const lock = join(f.root, '.agents', 'skills', '.unnc-moodle-install.lock');
  await writeFile(lock, 'busy'); await assert.rejects(installSkill(options), /active or interrupted/); await rm(lock);
  await rm(destination, { recursive: true });
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'SKILL.md'), 'OUTSIDE');
  await symlink(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkill(options), /unsafe/);
  assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), 'OUTSIDE');
  await rm(destination); await symlink(outside, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkill({ ...options, env: { CODEX_HOME: join(f.root, 'linked') } }), /symlink/);
});

test('authorized noninteractive skill installation works without build; no consent leaves it uninstalled', async t => {
  const f = await fixture(t); const path = fileURLToPath(new URL('../../scripts/install-skill.mjs', import.meta.url));
  const env = { ...process.env, CODEX_HOME: join(f.root, 'CLI home with spaces') };
  const noConsent = spawnSync(process.execPath, [path], { env, encoding: 'utf8', input: '' });
  assert.equal(noConsent.status, 1); assert.match(noConsent.stderr, /confirmation required/);
  const output = execFileSync(process.execPath, [path, '--yes'], { env, encoding: 'utf8' });
  assert.match(output, /Skill 已安装/);
  const installed = await readFile(join(env.CODEX_HOME, 'skills', 'unnc-moodle', 'SKILL.md'), 'utf8');
  assert.match(installed, /name: unnc-moodle/);
  assert.match(execFileSync(process.execPath, [path, '--yes'], { env, encoding: 'utf8' }), /无需重复安装/);
});
