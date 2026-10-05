import { mkdtemp, mkdir, readFile, writeFile, lstat, rename, rm, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO = 'MarkyMarkMa/unnc-moodle-mcp';
const ROOT_FILES = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', '.gitignore', 'codex-mcp.example.toml']);
export function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error('Unsupported release version');
  return match.slice(1).map(Number);
}
export function newer(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
export function chooseRelease(releases, current) {
  return releases.filter(r => !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
    .sort((a, b) => newer(a.tag_name, b.tag_name) ? -1 : newer(b.tag_name, a.tag_name) ? 1 : 0)
    .find(r => newer(r.tag_name, current));
}
export function checkedFiles(provenance) {
  if (provenance.schemaVersion !== 1 || provenance.dirty !== false || provenance.finalCandidate !== true || !Array.isArray(provenance.files)) throw new Error('Invalid public release provenance');
  const seen = new Set();
  for (const f of provenance.files) {
    if (typeof f.path !== 'string' || f.path.split('/').some(p => !p || p === '.' || p === '..') || /[\\\x00-\x1f]/.test(f.path) ||
        !(ROOT_FILES.has(f.path) || /^(src|test|scripts|docs|skills)\/[A-Za-z0-9_./-]+$/.test(f.path)) || !/^[a-f0-9]{64}$/.test(f.sha256) || ![0o644, 0o755].includes(f.mode) || seen.has(f.path)) throw new Error('Unsafe release file list');
    seen.add(f.path);
  }
  for (const required of ['package.json', 'package-lock.json', 'tsconfig.json', 'src/server.ts', 'src/config.ts']) if (!seen.has(required)) throw new Error('Incomplete release');
  return provenance.files;
}
async function exists(path) { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; } }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function dataLockPath() {
  const settingsPath = process.env.MOODLE_SETTINGS_FILE ?? join(homedir(), 'Library/Application Support/moodle-mcp/settings.json');
  const settings = await exists(settingsPath) ? await json(settingsPath) : undefined;
  const data = process.env.MOODLE_DATA_DIR ?? settings?.dataDir ?? join(homedir(), 'Documents/MoodleSync');
  if (await exists(join(data, '.moodle-storage.lock'))) throw new Error('Storage migration interrupted or active. Preserve both layouts and follow the recovery guide.');
  const legacy = join(data, 'state/operation.lock');
  const current = join(data, '_moodle/state/operation.lock');
  if (await exists(legacy) || await exists(current)) throw new Error('Moodle operation in progress. Wait for it to finish, then retry update.');
  return await exists(join(data, '_moodle/state')) ? current : legacy;
}
async function checkIdle() {
  if (await exists(await dataLockPath())) throw new Error('Moodle operation in progress. Wait for it to finish, then retry update.');
}
async function acquireDataLock() {
  const path = await dataLockPath();
  if (!await exists(dirname(path))) return async () => {};
  let h;
  try { h = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Moodle operation in progress; retry after it finishes.'); throw e; }
  try { await h.writeFile(JSON.stringify({ pid: process.pid, operation: 'program-update' })); }
  catch (e) { await h.close(); await rm(path); throw e; }
  await h.close();
  return async () => { await rm(path); };
}
async function fetchBytes(url, limit, fetcher) {
  const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'unnc-moodle-mcp-updater' }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`GitHub download failed (${response.status})`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw new Error('Release download too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const managed = ['src', 'test', 'scripts', 'docs', 'skills', ...ROOT_FILES, 'release-source.json', 'node_modules', 'dist'];

export async function installPrepared(target, prepared, backup, { move = rename, idle = checkIdle } = {}) {
  const moved = [], installed = [];
  await idle();
  // Preflight all entries before moving anything; never follow local symlinks.
  for (const name of managed) {
    const old = await exists(join(target, name));
    const next = await exists(join(prepared, name));
    if (old?.isSymbolicLink() || next?.isSymbolicLink()) throw new Error('Refusing symlink install entry');
  }
  try {
    for (const name of managed) {
      if (await exists(join(target, name))) { await move(join(target, name), join(backup, name)); moved.push(name); }
      if (await exists(join(prepared, name))) { await move(join(prepared, name), join(target, name)); installed.push(name); }
    }
  } catch (error) {
    try {
      for (const name of installed.reverse()) await rm(join(target, name), { recursive: true, force: true });
      for (const name of moved.reverse()) await rename(join(backup, name), join(target, name));
    } catch { throw new Error(`Update rollback incomplete. Preserve backup: ${backup}`); }
    throw error;
  }
}

export async function update(target, { fetcher = fetch, run = execFileSync, log = console.log, acquire = acquireDataLock } = {}) {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Updater requires macOS and Node.js 24+');
  target = await realpath(resolve(target));
  const pkg = await json(join(target, 'package.json'));
  if (pkg.name !== 'local-moodle-mcp') throw new Error('Run this command in the existing Moodle MCP installation');
  // Git installations retain their own source history; this updater serves ZIP installs.
  let gitCheckout = false;
  try { run('git', ['-C', target, 'rev-parse', '--show-toplevel'], { stdio: 'pipe' }); gitCheckout = true; } catch {}
  if (gitCheckout) throw new Error('Git checkout detected. Update through Git; automatic replacement is for ZIP installations.');
  await checkIdle();
  const lock = join(target, '.moodle-update-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new Error('Another update is active or interrupted; inspect .moodle-update-lock before retrying.'); throw e; }
  let workspace;
  try {
    const releases = JSON.parse((await fetchBytes(`https://api.github.com/repos/${REPO}/releases?per_page=100`, 4 * 1024 * 1024, fetcher)).toString());
    const release = chooseRelease(releases, pkg.version);
    if (!release) { log(`Already up to date (${pkg.version}).`); return { updated: false, version: pkg.version }; }
    const asset = release.assets?.find(a => a.name === `unnc-moodle-mcp-${release.tag_name}.zip`);
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') || asset.browser_download_url !== `https://github.com/${REPO}/releases/download/${release.tag_name}/${asset.name}`) throw new Error('Release ZIP or GitHub SHA-256 digest missing');
    log(`Preparing ${release.tag_name}; your course settings and materials stay in place.`);
    workspace = await mkdtemp(join(dirname(target), '.moodle-update-'));
    const archive = join(workspace, 'release.zip');
    const bytes = await fetchBytes(asset.browser_download_url, 32 * 1024 * 1024, fetcher);
    if ('sha256:' + hash(bytes) !== asset.digest) throw new Error('Release ZIP checksum mismatch');
    await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' });
    const entries = run('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
    if (entries.some(p => !p.startsWith('unnc-moodle-mcp/') || p.split('/').some(x => x === '..' || x === '.') || /[\\\x00-\x1f]/.test(p)) || new Set(entries).size !== entries.length) throw new Error('Unsafe ZIP entries');
    const extract = name => run('/usr/bin/unzip', ['-p', archive, 'unnc-moodle-mcp/' + name], { maxBuffer: 8 * 1024 * 1024 });
    const provenanceBytes = extract('release-source.json');
    const files = checkedFiles(JSON.parse(provenanceBytes.toString()));
    const allowed = new Set([...files.map(f => 'unnc-moodle-mcp/' + f.path), 'unnc-moodle-mcp/release-source.json']);
    if (entries.some(p => !p.endsWith('/') && !allowed.has(p))) throw new Error('Unexpected file in release ZIP');
    const prepared = join(workspace, 'prepared'); await mkdir(prepared, { mode: 0o700 });
    // Read each reviewed entry as bytes; never extract ZIP links or paths to disk.
    for (const f of files) {
      const content = extract(f.path);
      if (hash(content) !== f.sha256) throw new Error('Release source checksum mismatch');
      await mkdir(dirname(join(prepared, f.path)), { recursive: true });
      await writeFile(join(prepared, f.path), content, { mode: f.mode, flag: 'wx' });
    }
    await writeFile(join(prepared, 'release-source.json'), provenanceBytes);
    const next = await json(join(prepared, 'package.json'));
    if (next.name !== pkg.name || 'v' + next.version !== release.tag_name) throw new Error('Release version mismatch');
    const npm = process.env.npm_execpath;
    const install = args => npm ? run(process.execPath, [npm, ...args], { cwd: prepared, stdio: 'inherit' }) : run('npm', args, { cwd: prepared, stdio: 'inherit' });
    install(['ci']); install(['run', 'build']);
    await lstat(join(prepared, 'dist/src/server.js'));
    const backup = join(workspace, 'previous'); await mkdir(backup, { mode: 0o700 });
    await writeFile(join(workspace, 'update.json'), JSON.stringify({ target, oldVersion: pkg.version, newVersion: next.version, backup }, null, 2));
    const unlockData = await acquire();
    try { await installPrepared(target, prepared, backup, { idle: async () => {} }); }
    finally { await unlockData(); }
    log(`Updated to ${next.version}. Previous program backup: ${backup}`);
    log('Reconnect the Moodle MCP or restart Codex. Then ask Codex to check login/settings and organize existing materials without downloading them.');
    log('Your separately installed Codex skill is unchanged; the existing sync tools remain compatible.');
    return { updated: true, version: next.version, backup };
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] === '-' || (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const target = args.length === 2 && args[0] === '--install-dir' ? args[1] : args.length === 0 && process.argv[1] !== '-' ? resolve(dirname(fileURLToPath(import.meta.url)), '..') : undefined;
  if (!target) { console.error('Usage: node update.mjs [--install-dir EXISTING_INSTALL_DIRECTORY]'); process.exitCode = 1; }
  else try { await update(target); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
