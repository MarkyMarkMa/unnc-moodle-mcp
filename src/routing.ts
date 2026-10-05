import { readFileSync, lstatSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import { MoodleError, type StoredFile, type RemoteFile } from './model.js';
import { contained } from './platform.js';
import { inside } from './safety.js';

export const routingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('managed') }).strict(),
  z.object({ mode: z.literal('existing'), root: z.string().min(1), rules: z.array(z.object({
    courseId: z.number().int().positive(), directory: z.string().min(1),
    moduleIds: z.array(z.number().int().positive()).max(1000).optional(),
    keywords: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  }).strict().refine(r => !!r.moduleIds?.length || !!r.keywords?.length)).max(1000) }).strict(),
]);
export type Routing = z.infer<typeof routingSchema>;
export function loadRouting(dataDir: string): Routing | undefined {
  const path = join(dataDir, '_moodle', 'routing.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new MoodleError('STATE_INVALID');
    const routing = routingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    validatePaths(routing); return routing;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (e instanceof MoodleError) throw e;
    throw new MoodleError('STATE_INVALID');
  }
}
function validatePaths(routing: Routing): void {
  if (routing.mode !== 'existing') return;
  if (!isAbsolute(routing.root) || resolve(routing.root) !== routing.root) throw new MoodleError('PATH_UNSAFE');
  for (const r of routing.rules) {
    inside(routing.root, r.directory);
    if (r.directory.split(/[\\/]/).some(p => p.startsWith('.'))) throw new MoodleError('PATH_UNSAFE');
  }
}
export async function validateRouting(cfg: Config, routing: Routing): Promise<void> {
  validatePaths(routing);
  if (routing.mode !== 'existing') return;
  const reserved = [cfg.profileDir, join(cfg.dataDir, '_moodle'), cfg.stateDir, join(cfg.materialsDir, '.history')];
  if (routing.root === resolve(cfg.dataDir) || reserved.some(p => contained(p, routing.root) || contained(routing.root, p))) throw new MoodleError('PATH_UNSAFE');
  for (const r of routing.rules) if (!cfg.courses.some(c => c.id === r.courseId)) throw new MoodleError('INVALID_INPUT');
  const rootStat = await lstat(routing.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new MoodleError('PATH_UNSAFE');
  for (const r of routing.rules) await checkRouteDirectory(routing.root, r.directory);
}
export function routeFile(cfg: Config, file: RemoteFile, record?: StoredFile): { root: string; directory?: string; reason?: string } {
  const routing = cfg.routing;
  if (!routing || routing.mode === 'managed') return { root: cfg.materialsDir };
  const rules = routing.rules.filter(r => r.courseId === file.courseId);
  const exact = rules.filter(r => r.moduleIds?.includes(file.moduleId));
  if (!exact.length && record?.readableRoot === routing.root && record.routingDirectory) {
    inside(routing.root, record.routingDirectory);
    return { root: routing.root, directory: record.routingDirectory };
  }
  const text = [file.title, file.description, file.sectionName, file.filename].filter(Boolean).join('\n').normalize('NFKC').toLocaleLowerCase();
  const matches = exact.length ? exact : rules.filter(r => r.keywords?.some(k => text.includes(k.normalize('NFKC').toLocaleLowerCase())));
  const directories = [...new Set(matches.map(r => r.directory))];
  return directories.length === 1 ? { root: routing.root, directory: directories[0] } : {
    root: routing.root, reason: directories.length ? '分类规则冲突：请确认资源归属' : '没有匹配的分类规则：请确认资源归属',
  };
}

export async function checkRouteDirectory(root: string, directory: string): Promise<void> {
  const path = inside(root, directory);
  for (const target of [root, path]) {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MoodleError('PATH_UNSAFE');
  }
  // Allow OS aliases above the explicitly approved root (e.g. macOS /var),
  // but never symbolic links inside the user's chosen directory tree.
  if (await realpath(path) !== resolve(await realpath(root), directory)) throw new MoodleError('PATH_UNSAFE');
}
