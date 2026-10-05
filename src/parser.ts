import { MOODLE_ORIGIN, MoodleError, type SelectedCourse, type Course, type RemoteFile, type Resource, type ResourceType } from './model.js';
import { displayUrl, schoolUrl } from './safety.js';

export interface Anchor { href: string; text: string; context?: string; sectionName?: string; }
function url(a: Anchor): URL | undefined { try { return new URL(a.href, MOODLE_ORIGIN); } catch { return undefined; } }
function numericId(u: URL): number | undefined { const s = u.searchParams.get('id'); if (!s || !/^\d+$/.test(s)) return; const n = Number(s); return Number.isSafeInteger(n) && n > 0 ? n : undefined; }
export function parseCourses(anchors: Anchor[], hidden = false, selected: readonly SelectedCourse[] = []): Course[] {
  const result = new Map<number, Course>();
  for (const a of anchors) {
    const u = url(a); if (!u || u.origin !== MOODLE_ORIGIN || u.pathname !== '/course/view.php') continue;
    const id = numericId(u); if (!id || !a.text.trim()) continue;
    const name = a.text.trim().replace(/^(?:Starred course\s+)?(?:Course is starred\s+)?Course name\s+/i, '');
    if (!result.has(id)) result.set(id, { id, name, selected: selected.some(c => c.id === id), hidden });
  }
  return [...result.values()];
}
export function parseResources(courseId: number, anchors: Anchor[]): Resource[] {
  if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new MoodleError('INVALID_INPUT');
  const result = new Map<number, Resource>();
  for (const a of anchors) {
    const u = url(a); if (!u || u.origin !== MOODLE_ORIGIN || !a.text.trim()) continue;
    const match = /^\/mod\/([a-z][a-z0-9_]*)\/view\.php$/.exec(u.pathname); if (!match) continue;
    const moduleId = numericId(u); if (!moduleId) continue;
    const mod = match[1];
    // Assignment, forum and quiz links are listed as unsupported, never entered.
    const type: ResourceType = mod === 'resource' ? 'file' : ['folder', 'url', 'page', 'book'].includes(mod ?? '') ? mod as ResourceType : 'unsupported';
    const title = a.text.trim().replace(/\s+(File|Folder|URL|Page|Book|Forum|Assignment|Quiz)$/i, '');
    const format = /\b(PDF|PPTX?|DOCX?|XLSX?|ZIP)\b/i.exec(a.context ?? '')?.[1]?.toUpperCase();
    const sectionName = a.sectionName?.trim().replace(/\s+/g, ' ');
    const item: Resource = { courseId, moduleId, title, type, url: `${MOODLE_ORIGIN}${u.pathname}?id=${moduleId}`, ...(format ? { format } : {}), ...(sectionName ? { sectionName } : {}) };
    const old = result.get(moduleId);
    if (!old) result.set(moduleId, item);
    else result.set(moduleId, { ...old, ...(!old.format && format ? { format } : {}), ...(!old.sectionName && sectionName ? { sectionName } : {}) });
  }
  return [...result.values()];
}
export function resourceFile(resource: Resource): RemoteFile {
  if (resource.type !== 'file') throw new MoodleError('UNSUPPORTED');
  return { courseId: resource.courseId, moduleId: resource.moduleId, key: `${resource.courseId}:${resource.moduleId}:main`, title: resource.title, url: resource.url, remotePath: 'main', ...(resource.sectionName ? { sectionName: resource.sectionName } : {}) };
}
export function parseFolder(resource: Resource, anchors: Anchor[]): RemoteFile[] {
  const files = new Map<string, RemoteFile>();
  for (const a of anchors) {
    const u = url(a); if (!u || u.origin !== MOODLE_ORIGIN) continue;
    // Only published folder/content links on the requested folder page.
    const match = /^\/pluginfile\.php\/\d+\/mod_folder\/content\/\d+\/(.+)$/.exec(u.pathname);
    if (!match) continue;
    schoolUrl(u.href);
    let remotePath: string; try { remotePath = decodeURIComponent(match[1]!); } catch { throw new MoodleError('PARSE_FAILED'); }
    if (remotePath.includes('\0') || remotePath.split(/[\\/]/).includes('..')) throw new MoodleError('PATH_UNSAFE');
    const key = `${resource.courseId}:${resource.moduleId}:${remotePath}`;
    const parts = remotePath.split('/');
    files.set(key, { courseId: resource.courseId, moduleId: resource.moduleId, key, title: resource.title, url: u.href, remotePath, filename: parts.at(-1), relativeFolder: parts.slice(0, -1).join('/'), ...(resource.sectionName ? { sectionName: resource.sectionName } : {}) });
  }
  return [...files.values()];
}
export function externalLinks(anchors: Anchor[]): string[] {
  return [...new Set(anchors.map(a => url(a)).filter((u): u is URL => !!u && /^https?:$/.test(u.protocol) && u.origin !== MOODLE_ORIGIN).map(u => displayUrl(u.href)))];
}
