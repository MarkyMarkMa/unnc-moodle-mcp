import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// Maintainer export script is plain ESM, deliberately usable before building.
// @ts-ignore No declaration needed for this local maintenance module.
import { PUBLIC_FILES, exportPublic, checkPublicText } from '../../scripts/export-public.mjs';

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'moodle-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source);
  for (const path of PUBLIC_FILES as string[]) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), 'Synthetic public source\n');
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Synthetic release');
  return { root, source, git, destination: join(root, 'release') };
}
test('release exports only reviewed files with committed provenance and exact bytes', async t => {
  const { source, destination, git } = await fixture(t);
  await mkdir(join(source, 'verification')); await writeFile(join(source, 'verification', 'private.json'), 'Never export');
  await writeFile(join(source, '.gitignore'), 'verification/\n'); git('add', '.gitignore');
  git('-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Ignore private data');
  const result = await exportPublic(source, destination);
  assert.equal(result.sourceCommit, git('rev-parse', 'HEAD')); assert.equal(result.dirty, false); assert.equal(result.finalCandidate, true);
  assert.ok(!(await readdir(destination)).includes('.git')); assert.ok(!(await readdir(destination)).includes('verification'));
  for (const f of result.files) {
    const bytes = await readFile(join(destination, f.path));
    assert.deepEqual(bytes, await readFile(join(source, f.path)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), f.sha256);
  }
  assert.equal(JSON.parse(await readFile(join(destination, 'release-source.json'), 'utf8')).sourceCommit, result.sourceCommit);
});
test('dirty source blocked by default; explicit candidate records dirty files', async t => {
  const { source, destination } = await fixture(t); await writeFile(join(source, 'README.md'), 'Changed public source');
  await assert.rejects(exportPublic(source, destination), /dirty Git/);
  const result = await exportPublic(source, destination, { allowDirty: true });
  assert.equal(result.dirty, true); assert.equal(result.finalCandidate, false); assert.ok(result.gitStatus.some((x: string) => x.includes('README.md')));
});
test('unknown ignored fixture is refused rather than recursively copied', async t => {
  const { source, destination } = await fixture(t); await writeFile(join(source, 'test', 'personal.json'), 'private fixture');
  await assert.rejects(exportPublic(source, destination, { allowDirty: true }), /unreviewed file/);
  await assert.rejects(readFile(join(destination, 'release-source.json')), { code: 'ENOENT' });
});
test('personal markers block export without printing values', async t => {
  const { source, destination } = await fixture(t); const secret = ['/', 'Users', '/', 'private-person', '/notes'].join('');
  await writeFile(join(source, 'README.md'), secret);
  await assert.rejects(exportPublic(source, destination, { allowDirty: true }), (e: Error) => /personal absolute path/.test(e.message) && !e.message.includes(secret));
  assert.throws(() => checkPublicText(String(153000 + 232), 'fixture'), /private course/);
  assert.throws(() => checkPublicText('password' + '="' + 'x'.repeat(20) + '"', 'fixture'), /credential/);
});
test('symlink source and existing destination are never copied or overwritten', async t => {
  const { root, source, destination } = await fixture(t);
  await rm(join(source, 'README.md')); await symlink(join(root, 'outside'), join(source, 'README.md'));
  await assert.rejects(exportPublic(source, destination, { allowDirty: true }), /symlink/);
  await rm(join(source, 'README.md')); await writeFile(join(source, 'README.md'), 'Public');
  await mkdir(destination); await writeFile(join(destination, 'keep.txt'), 'Keep me');
  await assert.rejects(exportPublic(source, destination, { allowDirty: true }), { code: 'EEXIST' });
  assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'Keep me');
});

test('source archives without Git receive explicit maintenance-checkout guidance', async t => {
  const { source, destination } = await fixture(t); await rm(join(source, '.git'), { recursive: true });
  await assert.rejects(exportPublic(source, destination), /Git maintenance checkout/);
});
test('launcher executable permission survives export', { skip: process.platform === 'win32' }, async t => {
  const { source, destination, git } = await fixture(t); await chmod(join(source, 'scripts/setup.command'), 0o755);
  git('add', '.'); git('-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Executable launcher');
  await exportPublic(source, destination);
  assert.ok((await lstat(join(destination, 'scripts/setup.command'))).mode & 0o111);
});
