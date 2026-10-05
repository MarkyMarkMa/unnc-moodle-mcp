import { browserChannel, sessionModeUnsafe } from './platform.js';
import { chromium, type BrowserContext, type Page, type APIResponse } from 'playwright';
import { readFile, open, lstat, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from './config.js';
import { approvedCourse } from './config.js';
import { MOODLE_ORIGIN, MoodleError, atStage, type Backend, type Course, type DownloadResult, type RemoteFile, type Resource, type StoredFile } from './model.js';
import { parseCourses, parseFolder, parseResources, resourceFile, type Anchor } from './parser.js';
import { privateDirectory, removeStaging, safeFilename, schoolUrl } from './safety.js';

export function responseCode(status: number): void {
  if (status === 401) throw new MoodleError('NEEDS_LOGIN');
  if (status === 403) throw new MoodleError('FORBIDDEN');
  if (status === 404 || status === 410) throw new MoodleError('NOT_FOUND');
  if (status === 429) throw new MoodleError('RATE_LIMITED');
  if (status >= 400) throw new MoodleError('NETWORK');
}
export function dispositionFilename(value: string | undefined): string | undefined {
  if (!value) return;
  const utf = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf) { try { return safeFilename(decodeURIComponent(utf.trim())); } catch { /* try plain fallback */ } }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(value);
  const name = plain?.[1] ?? plain?.[2]; return name?.trim() ? safeFilename(name.trim()) : undefined;
}
export class BrowserBackend implements Backend {
  private context?: BrowserContext;
  private page?: Page;
  private lastRequest = 0;
  constructor(private readonly cfg: Config) {}
  private async pace(): Promise<void> {
    const remaining = this.cfg.requestIntervalMs - (Date.now() - this.lastRequest);
    if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
    this.lastRequest = Date.now();
  }
  private async session(): Promise<BrowserContext> {
    if (this.context) return this.context;
    await privateDirectory(this.cfg.profileDir);
    const sessionFile = join(this.cfg.profileDir, 'moodle-session.json');
    let state: { cookies: Parameters<BrowserContext['addCookies']>[0] };
    try {
      const s = await lstat(sessionFile); if (!s.isFile() || s.isSymbolicLink() || sessionModeUnsafe(s.mode)) throw new MoodleError('PATH_UNSAFE');
      const h = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { state = JSON.parse(await h.readFile('utf8')) as typeof state; } finally { await h.close(); }
      if (!Array.isArray(state.cookies) || !state.cookies.length || state.cookies.some(c => c.domain?.replace(/^\./, '') !== 'moodle.nottingham.ac.uk')) throw new MoodleError('NEEDS_LOGIN');
    } catch (e) { if (e instanceof MoodleError) throw e; throw new MoodleError('NEEDS_LOGIN'); }
    try {
      this.context = await chromium.launchPersistentContext(this.cfg.profileDir, {
        channel: browserChannel(), headless: this.cfg.headless, acceptDownloads: false,
        serviceWorkers: 'block', chromiumSandbox: true,
      });
      await this.context.addCookies(state.cookies);
      // This automation context only reads Moodle. Manual authentication uses
      // scripts/login.mjs, which intentionally permits the school's SSO redirects.
      await this.context.route('**/*', async route => {
        const u = new URL(route.request().url());
        let readOnlyAjax = false;
        if (u.origin === MOODLE_ORIGIN && u.pathname === '/lib/ajax/service.php' && route.request().method() === 'POST') {
          try {
            const calls: unknown = route.request().postDataJSON();
            readOnlyAjax = Array.isArray(calls) && calls.length > 0 && calls.every(x =>
              x && ['core_course_get_enrolled_courses_by_timeline_classification', 'tool_banner_get_banners'].includes(x.methodname));
          } catch { /* Refuse unknown calls and all writes. */ }
        }
        if (u.origin !== MOODLE_ORIGIN || (!['GET', 'HEAD'].includes(route.request().method()) && !readOnlyAjax)) await route.abort();
        else await route.continue();
      });
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      this.page.setDefaultTimeout(this.cfg.timeoutMs);
      return this.context;
    } catch (e) {
      await this.close();
      if (e instanceof MoodleError) throw e;
      // Never expose Playwright diagnostics (profile/session paths or URLs).
      throw new MoodleError('PROFILE_BUSY');
    }
  }
  private async navigate(value: string): Promise<Page> {
    const u = schoolUrl(value); await this.session(); await this.pace();
    const p = this.page!;
    let response;
    try { response = await p.goto(u.href, { waitUntil: 'domcontentloaded', timeout: this.cfg.timeoutMs }); }
    catch { if (/\/(login|auth)\//.test(new URL(p.url()).pathname)) throw new MoodleError('NEEDS_LOGIN'); throw new MoodleError('NETWORK'); }
    schoolUrl(p.url());
    if (response) responseCode(response.status());
    const main = p.locator('#region-main, main').first();
    await main.waitFor({ state: 'visible', timeout: this.cfg.timeoutMs }).catch(() => { throw new MoodleError('PARSE_FAILED'); });
    if (await p.locator('input[type=password]').count()) throw new MoodleError('NEEDS_LOGIN');
    if (await p.locator('.errorbox, .alert-danger').count()) {
      const text = await p.locator('.errorbox, .alert-danger').allTextContents();
      if (/permission|not available|cannot access|not enrolled/i.test(text.join(' '))) throw new MoodleError('FORBIDDEN');
    }
    return p;
  }
  private async anchors(p: Page, selector = '#region-main a[href], main a[href]'): Promise<Anchor[]> {
    return p.locator(selector).evaluateAll(es => es.map(e => {
      let section = e.closest('.section, [data-for="section"]');
      // Moodle also calls the inner activity UL 'section'; climb to the
      // enclosing teaching section that actually carries its title.
      while (section && !section.querySelector('.sectionname, .section-title, [data-for="section_title"]') && !section.hasAttribute('aria-labelledby')) {
        section = section.parentElement?.closest('.section, [data-for="section"]') ?? null;
      }
      const heading = section?.querySelector('.sectionname') ?? section?.querySelector('.section-title') ?? section?.querySelector('[data-for="section_title"]');
      const labelled = section?.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
      const sectionName = (heading?.textContent || labelled || '').trim().replace(/\s+/g, ' ');
      return {
      href: e.getAttribute('href') ?? '', text: (e.textContent ?? '').trim().replace(/\s+/g, ' '),
      context: (e.closest('.activity')?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 300),
      ...(sectionName ? { sectionName } : {}),
    }; }));
  }
  async checkConnection() {
    try {
      const p = await this.navigate(MOODLE_ORIGIN + '/');
      const authenticated = await p.getByText('My Modules', { exact: true }).count() > 0;
      return { connected: true, authenticated, needsLogin: !authenticated };
    } catch (e) {
      if (e instanceof MoodleError && e.code === 'NEEDS_LOGIN') return { connected: true, authenticated: false, needsLogin: true };
      throw e;
    }
  }
  private async grouping(p: Page, label: string): Promise<void> {
    await p.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    // Refused unrelated messaging AJAX can trigger Moodle's generic error
    // dialogue. Dismiss only that known empty exception, never site warnings.
    for (const dialog of await p.locator('.moodle-dialogue-exception[aria-hidden="false"]').all()) {
      const text = await dialog.textContent() ?? '';
      if ((text.startsWith('undefinedFile:') || (text.includes('Failed to fetch') && text.includes('setUserPreference'))) && await dialog.isVisible()) {
        await dialog.locator('button[aria-label="Close"]').click();
      }
    }
    const toggle = p.locator('#groupingdropdown');
    await toggle.click();
    // Moodle renders controls before its AMD click handlers are ready.
    // A failed first click is observed, then retried once after hydration.
    if (await toggle.getAttribute('aria-expanded') !== 'true') {
      await p.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await toggle.click();
    }
    const classification = ({ 'All modules': 'all', 'Show hidden modules': 'hidden', 'Show starred modules': 'favourites' } as Record<string, string>)[label];
    const loaded = p.waitForResponse(response => {
      try {
        return new URL(response.url()).pathname === '/lib/ajax/service.php' &&
          response.request().postDataJSON().some((x: { methodname: string; args?: { classification?: string } }) =>
            x.methodname === 'core_course_get_enrolled_courses_by_timeline_classification' && x.args?.classification === classification);
      } catch { return false; }
    }, { timeout: this.cfg.timeoutMs });
    const option = p.locator(`a[aria-label="${label}"]`);
    if (await option.count()) await option.click();
    else await p.getByText(label, { exact: true }).click();
    const response = await loaded;
    const body = await response.json();
    const ids: number[] = body[0]?.data?.courses?.map((c: { id: number }) => c.id);
    if (!Array.isArray(ids)) throw new MoodleError('PARSE_FAILED');
    await p.waitForFunction(expected => {
      const current = [...document.querySelectorAll('#region-main a[href], main a[href]')].flatMap(e => {
        try { const u = new URL(e.getAttribute('href') ?? '', location.origin); return u.pathname === '/course/view.php' ? [Number(u.searchParams.get('id'))] : []; } catch { return []; }
      });
      return expected.every(id => current.includes(id)) && current.every(id => expected.includes(id));
    }, ids, { timeout: this.cfg.timeoutMs });
    await p.locator('[data-region="course-view-content"] .loading-icon').waitFor({ state: 'hidden' }).catch(() => {});
    await p.locator('a[href*="/course/view.php"]').first().waitFor({ timeout: this.cfg.timeoutMs }).catch(() => {});
  }
  async listCourses(): Promise<Course[]> {
    let p = await this.navigate(MOODLE_ORIGIN + '/my/courses.php');
    const result = new Map<number, Course>();
    try {
      for (const [label, hidden] of [['All modules', false], ['Show hidden modules', true]] as const) {
        // Refused preference writes can raise a delayed Moodle exception.
        // Reload before the second filter so no previous-page dialogue survives.
        if (hidden) p = await this.navigate(MOODLE_ORIGIN + '/my/courses.php');
        const desiredText = hidden ? 'Removed from my view' : 'All';
        const currentText = (await p.locator('#groupingdropdown').innerText()).trim();
        if (currentText !== desiredText) await this.grouping(p, label);
        else await p.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const perPage = p.getByRole('button', { name: /items per page/ });
        if (await perPage.count() && !/\bAll\b/.test(await perPage.innerText())) {
          await perPage.click();
          const all = p.getByRole('menuitem', { name: 'All', exact: true });
          if (await all.count()) await all.click(); else await p.getByText('All', { exact: true }).last().click();
          await p.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { throw new MoodleError('NETWORK'); });
        }
        const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
          const courses = parseCourses(await this.anchors(p), hidden, this.cfg.courses);
          const fingerprint = courses.map(c => c.id).join(',');
          if (seen.has(fingerprint)) throw new MoodleError('PARSE_FAILED');
          seen.add(fingerprint); for (const c of courses) result.set(c.id, c);
          const next = p.getByRole('link', { name: 'Next page', exact: true });
          if (!await next.count() || !await next.first().isVisible() || await next.first().getAttribute('aria-disabled') === 'true' || await next.first().evaluate(e => !!e.closest('.disabled'))) break;
          await next.first().click();
          await p.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { throw new MoodleError('NETWORK'); });
          await this.pace();
          if (i === 99) throw new MoodleError('PARSE_FAILED');
        }
      }
    } finally { /* User preference writes are refused; the original saved view is unchanged. */ }
    if (!result.size) throw new MoodleError('PARSE_FAILED');
    return [...result.values()];
  }
  private async courseContentReady(p: Page): Promise<void> {
    // Require a recognized course/section structure, not merely a visible main.
    // Empty sections are valid; loading indicators anywhere in that structure
    // prevent committing a partial discovery as remote deletion.
    try {
      await p.waitForFunction(() => {
        const root = document.querySelector('#region-main .course-content, main .course-content');
        if (!root || !root.querySelector('.section, [data-for="section"]')) return false;
        const visible = (e: Element) => !!(e as HTMLElement).getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
        const main = root.closest('#region-main, main')!;
        return !main.matches('[aria-busy="true"]') && ![...main.querySelectorAll('[aria-busy="true"], .loading, .loading-icon, .spinner, [data-region="loading"]')].some(visible);
      }, undefined, { timeout: this.cfg.timeoutMs });
    } catch { throw new MoodleError('PARSE_FAILED', undefined, 'discovery'); }
  }
  async listResources(courseId: number): Promise<Resource[]> {
    approvedCourse(courseId, this.cfg.courses);
    const p = await this.navigate(`${MOODLE_ORIGIN}/course/view.php?id=${courseId}`);
    const result = new Map<number, Resource>();
    const collect = async () => {
      await this.courseContentReady(p);
      for (const r of parseResources(courseId, await this.anchors(p))) {
        const previous = result.get(r.moduleId);
        result.set(r.moduleId, { ...previous, ...r, ...(r.sectionName || previous?.sectionName ? { sectionName: r.sectionName ?? previous?.sectionName } : {}) });
      }
    };
    await collect();
    const sectionUrls = await p.locator('#region-main a[href], main a[href]').evaluateAll(es => [...new Set(es.map(e => e.getAttribute('href') ?? '').filter(h => /\/course\/section\.php\?id=\d+/.test(h)))]);
    // Section links are discovered on this course, never guessed or enumerated.
    if (sectionUrls.length > 100) throw new MoodleError('PARSE_FAILED');
    for (const sectionUrl of sectionUrls) {
      await this.navigate(sectionUrl); await collect();
    }
    return [...result.values()];
  }
  async listFiles(resource: Resource): Promise<RemoteFile[]> {
    approvedCourse(resource.courseId, this.cfg.courses);
    if (resource.type === 'file') return [resourceFile(resource)];
    if (resource.type !== 'folder') throw new MoodleError('UNSUPPORTED');
    const p = await this.navigate(resource.url);
    const files = parseFolder(resource, await this.anchors(p));
    if (!files.length) throw new MoodleError('PARSE_FAILED');
    return files;
  }
  private async request(value: string, headers: Record<string, string> = {}): Promise<APIResponse> {
    const ctx = await this.session(); let u = schoolUrl(value);
    for (let i = 0; i < 8; i++) {
      await this.pace();
      let response: APIResponse;
      try { response = await ctx.request.get(u.href, { headers, maxRedirects: 0, timeout: this.cfg.timeoutMs, failOnStatusCode: false }); }
      catch { throw new MoodleError('NETWORK'); }
      const status = response.status();
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers()['location']; await response.dispose();
        if (!location) throw new MoodleError('PARSE_FAILED');
        u = schoolUrl(location, u.href); continue;
      }
      try { responseCode(status); } catch (e) { await response.dispose(); throw e; }
      return response;
    }
    throw new MoodleError('NETWORK');
  }
  private async downloadOnce(file: RemoteFile, stagingDir: string, previous?: StoredFile, force = false, depth = 0): Promise<DownloadResult> {
    if (depth > 2) throw new MoodleError('PARSE_FAILED');
    const headers: Record<string, string> = {};
    if (!force && previous?.etag) headers['If-None-Match'] = previous.etag;
    // Last-Modified is recorded for diagnostics, but is not trusted alone:
    // Moodle can retain the same timestamp or expose a generic page timestamp.
    const response = await this.request(file.url, headers);
    try {
      if (response.status() === 304) return { kind: 'not_modified' };
      const h = response.headers(); const mime = (h['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const declared = Number(h['content-length']); if (declared > this.cfg.maxBytes) throw new MoodleError('FILE_TOO_LARGE');
      let body: Buffer;
      try { body = await response.body(); } catch { throw new MoodleError('NETWORK'); }
      if (body.length > this.cfg.maxBytes) throw new MoodleError('FILE_TOO_LARGE');
      if (declared > 0 && !h['content-encoding'] && body.length !== declared) throw new MoodleError('NETWORK');
      const htmlResponse = mime === 'text/html' || mime === 'application/xhtml+xml' || /^\s*(<!doctype html|<html)/i.test(body.subarray(0, 300).toString());
      const actualFile = /^\/pluginfile\.php\/\d+\/mod_(?:resource|folder)\/content\//.test(new URL(response.url()).pathname);
      if (htmlResponse) {
        const html = body.toString('utf8');
        if (/type\s*=\s*["']password|\/login\/index\.php/.test(html)) throw new MoodleError('NEEDS_LOGIN');
        if (!actualFile) {
        // Parse fetched HTML without navigating it: resource pages may auto-open
        // a file, and HTML lecture files must never execute during sync.
        const parsed = await this.page!.evaluate(source => {
          const doc = new DOMParser().parseFromString(source, 'text/html');
          return { base: doc.querySelector('base[href]')?.getAttribute('href'), candidates: [...doc.querySelectorAll('#region-main a[href], #region-main iframe[src], #region-main object[data], #region-main embed[src], main a[href], main iframe[src], main object[data], main embed[src]')].map(e => e.getAttribute('href') ?? e.getAttribute('src') ?? e.getAttribute('data') ?? '') };
        }, html);
        const base = parsed.base ? schoolUrl(parsed.base, response.url()).href : response.url();
        const direct = [...new Set(parsed.candidates.flatMap(x => {
          try { const u = schoolUrl(x, base); return /^\/pluginfile\.php\//.test(u.pathname) ? [u.href] : []; } catch { return []; }
        }))];
        if (direct.length !== 1) throw new MoodleError('PARSE_FAILED');
        return this.downloadOnce({ ...file, url: direct[0]! }, stagingDir, previous, force, depth + 1);
        }
      }
      if (!body.length) throw new MoodleError('PARSE_FAILED');
      const filename = dispositionFilename(h['content-disposition']) ?? safeFilename(file.filename ?? (actualFile ? decodeURIComponent(new URL(response.url()).pathname.split('/').at(-1)!) : file.title + (mime === 'application/pdf' ? '.pdf' : '.bin')));
      await privateDirectory(stagingDir);
      const stagingPath = join(stagingDir, randomUUID() + '.part');
      const handle = await open(stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(body); await handle.sync(); }
      catch (e) { await removeStaging(stagingPath); throw e; }
      finally { await handle.close(); }
      await chmod(stagingPath, 0o600);
      return { kind: 'downloaded', stagingPath, filename, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length, mime,
        ...(h['etag'] ? { etag: h['etag'] } : {}), ...(h['last-modified'] ? { lastModified: h['last-modified'] } : {}) };
    } finally { await response.dispose(); }
  }
  async download(file: RemoteFile, stagingDir: string, previous?: StoredFile, force = false): Promise<DownloadResult> {
    approvedCourse(file.courseId, this.cfg.courses); schoolUrl(file.url);
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return { ...await this.downloadOnce(file, stagingDir, previous, force), attempts: attempt + 1 }; }
      catch (e) {
        const error = atStage(e, 'download'); error.attempts = attempt + 1;
        if (!(e instanceof MoodleError) || !['NETWORK', 'PARSE_FAILED'].includes(e.code) || attempt === 2) { error.automaticRetryExhausted = attempt === 2 && ['NETWORK', 'PARSE_FAILED'].includes(error.code); throw error; }
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw new MoodleError('NETWORK');
  }
  async close(): Promise<void> { const ctx = this.context; this.context = undefined; this.page = undefined; await ctx?.close().catch(() => {}); }
}
