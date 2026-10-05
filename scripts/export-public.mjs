import { mkdir, readFile, writeFile, lstat, readdir, rm } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// New release files need explicit review; never copy a whole fixture directory.
export const PUBLIC_FILES = [
  'src/browser.ts', 'src/cli.ts', 'src/config.ts', 'src/model.ts', 'src/parser.ts',
  'src/layout.ts', 'src/safety.ts', 'src/server.ts', 'src/service.ts', 'src/sync.ts',
  'src/storage.ts', 'test/storage.test.ts', 'src/setup.ts', 'src/onboarding.ts', 'src/platform.ts',
  'test/platform.test.ts', 'test/config.test.ts', 'test/core.test.ts', 'test/download.test.ts',
  'test/update.test.ts', 'test/mcp.test.ts', 'test/pagination.test.ts', 'test/release.test.ts', 'test/setup.test.ts',
  'scripts/update.mjs', 'scripts/login.mjs', 'scripts/export-public.mjs', 'scripts/setup.command', 'scripts/setup.cmd', 'scripts/doctor.mjs',
  'docs/README.zh.md', 'docs/USAGE.md', 'docs/USAGE.zh.md', 'docs/RELEASE.md', 'docs/TESTING.md', 'skills/unnc-moodle/SKILL.md',
  'package.json', 'package-lock.json', 'tsconfig.json', 'README.md',
  'LICENSE', '.gitignore', 'codex-mcp.example.toml',
];
const markers = [
  ['personal absolute path', /\/(?:Users|home)\/(?!USER(?:\/|$)|USERNAME(?:\/|$)|<[^>]+>)([^/\s"'`]+)/],
  ['private course/resource identifier', new RegExp('\\b(?:' + [153000 + 232, 153000 + 307, 153000 + 234, 9120000 + 907].join('|') + ')\\b')],
  ['credential assignment', /["']?(?:MoodleSession|wstoken|password|authorization)["']?\s*[:=]\s*["'](?:Bearer\s+)?[A-Za-z0-9+/_=-]{12,}["']/i],
];
export function checkPublicText(text, path) {
  for (const [category, pattern] of markers) if (pattern.test(text)) throw new Error(`Release blocked: ${category} in ${path}; matching value suppressed`);
}
function git(source, args) {
  try { return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(); }
  catch { throw new Error('Release export requires a Git maintenance checkout with an existing commit; source archives cannot be re-exported directly'); }
}
export async function exportPublic(source, destination, { allowDirty = false } = {}) {
  source = resolve(source);
  if (!isAbsolute(destination)) throw new Error('Provide a new absolute destination directory');
  destination = resolve(destination);
  if (destination === source || destination.startsWith(source + '/')) throw new Error('Destination must be outside source');
  const root = git(source, ['rev-parse', '--show-toplevel']);
  const commit = git(source, ['rev-parse', 'HEAD']);
  const status = git(source, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status && !allowDirty) throw new Error('Release blocked: dirty Git worktree; commit reviewed changes first, or use --allow-dirty for a non-final candidate');
  const allowed = new Set(PUBLIC_FILES);
  async function inspect(dir) {
    if ((await lstat(join(source, dir))).isSymbolicLink()) throw new Error(`Release blocked: symlink directory: ${dir}`);
    for (const e of await readdir(join(source, dir), { withFileTypes: true })) {
      const path = dir + '/' + e.name;
      if (path === 'scripts/verify-real.mjs') continue; // Private maintenance tool.
      if (e.isDirectory()) await inspect(path);
      else if (!allowed.has(path)) throw new Error(`Release blocked: unreviewed file: ${path}`);
    }
  }
  for (const dir of ['src', 'test', 'scripts', 'docs', 'skills']) await inspect(dir);
  const files = [];
  for (const path of PUBLIC_FILES) {
    let current = join(source, path);
    while (current !== source) {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Release blocked: symlink at ${path}`);
      current = dirname(current);
    }
    if (!(await lstat(join(source, path))).isFile()) throw new Error(`Release blocked: not a regular file: ${path}`);
    const bytes = await readFile(join(source, path));
    if (bytes.includes(0)) throw new Error(`Release blocked: unexpected binary file: ${path}`);
    checkPublicText(bytes.toString('utf8'), path);
    files.push({ path, bytes, mode: ((await lstat(join(source, path))).mode & 0o111) ? 0o755 : 0o644, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  for (const f of files) if (!f.bytes.equals(await readFile(join(source, f.path)))) throw new Error('Release blocked: source changed during export');
  if (commit !== git(source, ['rev-parse', 'HEAD']) || status !== git(source, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Release blocked: Git state changed during export');
  const provenance = { schemaVersion: 1, sourceCommit: commit, sourceSubdirectory: relative(root, source) || '.', dirty: !!status,
    finalCandidate: !status, gitStatus: status ? status.split('\n') : [], files: files.map(({ path, sha256, mode }) => ({ path, sha256, mode })) };
  checkPublicText(JSON.stringify(provenance), 'release-source.json');
  await mkdir(destination); // Never merge into or clean up somebody else's output.
  try {
    for (const f of files) { await mkdir(dirname(join(destination, f.path)), { recursive: true }); await writeFile(join(destination, f.path), f.bytes, { flag: 'wx', mode: f.mode }); }
    await writeFile(join(destination, 'release-source.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  return provenance;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const allowDirty = args.includes('--allow-dirty');
  const positional = args.filter(x => x !== '--allow-dirty');
  if (positional.length !== 1) throw new Error('Usage: node scripts/export-public.mjs /absolute/new-directory [--allow-dirty]');
  const provenance = await exportPublic(resolve(dirname(fileURLToPath(import.meta.url)), '..'), positional[0], { allowDirty });
  console.log(`Public source exported; source commit ${provenance.sourceCommit}; dirty=${provenance.dirty}; finalCandidate=${provenance.finalCandidate}. Private data and Git history excluded.`);
}
