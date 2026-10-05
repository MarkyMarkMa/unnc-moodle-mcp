import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MOODLE_ORIGIN, MoodleError } from './model.js';

export function schoolUrl(value: string, base = MOODLE_ORIGIN): URL {
  let u: URL;
  try { u = new URL(value, base); } catch { throw new MoodleError('INVALID_INPUT'); }
  if (u.origin !== MOODLE_ORIGIN || u.username || u.password) throw new MoodleError('EXTERNAL_LINK');
  if ([...u.searchParams.keys()].some(k => /^(token|wstoken|sesskey|password|key)$/i.test(k))) throw new MoodleError('UNSUPPORTED');
  if (/^\/(login|auth)\//.test(u.pathname)) throw new MoodleError('NEEDS_LOGIN');
  return u;
}
export function displayUrl(value: string): string {
  try { const u = new URL(value); return u.origin + u.pathname; } catch { return '[invalid URL]'; }
}
export function safeFilename(value: string): string {
  let name = value.normalize('NFKC').replace(/[\x00-\x1f\x7f/\\:<>"|?*]/g, '_').replace(/^\.+/, '').trim().replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'resource.bin';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  // Keep the extension and stay well below macOS' per-component byte limit.
  if (Buffer.byteLength(name) > 180) {
    const extension = /\.[A-Za-z0-9]{1,12}$/.exec(name)?.[0] ?? '';
    let stem = extension ? name.slice(0, -extension.length) : name;
    while (Buffer.byteLength(stem) > 160) stem = stem.slice(0, -1);
    name = stem + extension;
  }
  return name;
}
export function inside(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).some(p => p === '..' || !p || p === '.')) throw new MoodleError('PATH_UNSAFE');
  const out = resolve(root, rel); const diff = relative(resolve(root), out);
  if (!diff || diff.startsWith('..' + sep) || diff === '..' || isAbsolute(diff)) throw new MoodleError('PATH_UNSAFE');
  return out;
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MoodleError('PATH_UNSAFE');
  await chmod(path, 0o700);
}
export async function safeDirectory(root: string, rel: string): Promise<string> {
  const out = inside(root, rel); await privateDirectory(root);
  let current = resolve(root);
  for (const part of relative(root, out).split(sep)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch(async e => { if (e.code !== 'EEXIST') throw e; });
    const s = await lstat(current);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new MoodleError('PATH_UNSAFE');
  }
  if (!(await realpath(out)).startsWith((await realpath(root)) + sep)) throw new MoodleError('PATH_UNSAFE');
  return out;
}
export async function regularFile(root: string, rel: string): Promise<string | undefined> {
  const file = inside(root, rel);
  try {
    let current = dirname(file);
    while (current !== resolve(root)) {
      const s = await lstat(current); if (s.isSymbolicLink() || !s.isDirectory()) throw new MoodleError('PATH_UNSAFE');
      current = dirname(current);
    }
    const rootStat = await lstat(root); if (rootStat.isSymbolicLink()) throw new MoodleError('PATH_UNSAFE');
    const s = await lstat(file); if (s.isSymbolicLink() || !s.isFile()) throw new MoodleError('PATH_UNSAFE');
    return file;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export async function fileHash(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const hash = createHash('sha256'); for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); return hash.digest('hex'); }
  finally { await handle.close(); }
}
export function fileSlot(remotePath: string): string { return createHash('sha256').update(remotePath).digest('hex').slice(0, 24); }
export async function removeStaging(path: string | undefined): Promise<void> { if (path) await unlink(path).catch(() => {}); }
export function isSimpleBasename(value: string): boolean { return basename(value) === value && safeFilename(value) === value; }
