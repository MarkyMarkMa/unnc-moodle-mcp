import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { BrowserBackend } from '../src/browser.js';
import { config } from '../src/config.js';

test('browser course listing handles pagination and a delayed hidden-course response', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  try {
    const context = await browser.newContext();
    const p = await context.newPage();
    const all = [{ id: 101, fullname: 'ODE' }, { id: 102, fullname: 'Probability' }, { id: 103, fullname: 'Analysis' }];
    const hidden = [{ id: 100, fullname: 'Old course' }];
    await context.route('https://moodle.nottingham.ac.uk/**', async route => {
      if (new URL(route.request().url()).pathname === '/lib/ajax/service.php') {
        await new Promise(r => setTimeout(r, 800));
        await route.fulfill({ json: [{ error: false, data: { courses: hidden } }] }); return;
      }
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><main id="region-main"><h1>My Modules</h1>
        <button id="groupingdropdown" aria-label="Grouping drop-down menu" aria-expanded="false">All</button>
        <a aria-label="Show hidden modules" role="menuitem" href="#" id="hidden-option" style="display:none">Removed from my view</a>
        <div id="courses"></div><span id="next-parent" class="page-item"><a href="#" aria-label="Next page">Next</a></span>
        <script>
        const all=${JSON.stringify(all)};let offset=0;
        function render(courses){document.querySelector('#courses').innerHTML=courses.map(c=>'<a href="/course/view.php?id='+c.id+'">'+c.fullname+'</a>').join('');}
        render(all.slice(0,2));
        document.querySelector('[aria-label="Next page"]').onclick=e=>{e.preventDefault();offset+=2;render(all.slice(offset,offset+2));document.querySelector('#next-parent').className='page-item disabled';};
        document.querySelector('#groupingdropdown').onclick=()=>{document.querySelector('#groupingdropdown').setAttribute('aria-expanded','true');document.querySelector('#hidden-option').style.display='block';};
        document.querySelector('#hidden-option').onclick=async e=>{e.preventDefault();document.querySelector('#groupingdropdown').textContent='Removed from my view';document.querySelector('#hidden-option').style.display='none';const r=await fetch('/lib/ajax/service.php',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify([{methodname:'core_course_get_enrolled_courses_by_timeline_classification',args:{classification:'hidden'}}])});const data=await r.json();render(data[0].data.courses);document.querySelector('#next-parent').className='page-item disabled';};
        </script></main>` });
    });
    const backend = new BrowserBackend({ ...config(), setupConfirmed: true, courses: [{ id: 101, name: 'Example course' }], requestIntervalMs: 0, timeoutMs: 5000 });
    const internals = backend as unknown as { session: () => Promise<BrowserContext>; page: Page };
    internals.session = async () => context; internals.page = p;
    const courses = await backend.listCourses();
    assert.deepEqual(courses.map(c => c.id), [101, 102, 103, 100]);
    assert.equal(courses[3]?.hidden, true); assert.equal(courses[3]?.selected, false);
  } finally { await browser.close(); }
});

test('resource discovery waits for recognized empty/delayed course content and rejects partial sections', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  t.after(() => browser.close()); const context = await browser.newContext(); const p = await context.newPage();
  const cfg = { ...config(), setupConfirmed: true, courses: [{ id: 101, name: 'Example' }], requestIntervalMs: 0, timeoutMs: 500 };
  const backend = new BrowserBackend(cfg);
  const internals = backend as unknown as { session: () => Promise<BrowserContext>; page: Page };
  internals.session = async () => context; internals.page = p;
  let mode = 'loading';
  await context.route('https://moodle.nottingham.ac.uk/**', route => {
    const section = route.request().url().includes('/course/section.php');
    const content = mode === 'empty' ? '<div class="course-content"><li class="section"></li></div>' :
      mode === 'delayed' ? '<div class="course-content"><li class="section"><span class="loading">Loading</span></li></div><script>setTimeout(()=>{document.querySelector(".section").innerHTML=\'<a href="/mod/resource/view.php?id=201">Notes File</a>\'},100)</script>' :
      mode === 'partial' && !section ? '<div class="course-content"><li class="section"><a href="/mod/resource/view.php?id=201">Notes File</a><a href="/course/section.php?id=303">Section</a></li></div>' : 'Loading';
    return route.fulfill({ contentType: 'text/html', body: '<main id="region-main">' + content + '</main>' });
  });
  await assert.rejects(backend.listResources(101), /解析|可靠/);
  mode = 'empty'; assert.deepEqual(await backend.listResources(101), []);
  mode = 'delayed'; assert.equal((await backend.listResources(101))[0]?.moduleId, 201);
  mode = 'partial'; await assert.rejects(backend.listResources(101), /解析|可靠/);
});

test('wrapper iframe/object/embed URLs resolve against response URL and document base', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { resourceFile } = await import('../src/parser.js');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true }); t.after(() => browser.close());
  const page = await browser.newPage(); const dir = await mkdtemp(join(tmpdir(), 'moodle-relative-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = resourceFile({ courseId: 101, moduleId: 201, title: 'Notes', type: 'file', url: 'https://moodle.nottingham.ac.uk/mod/resource/view.php?id=201' });
  for (const tag of ['iframe', 'object', 'embed']) {
    for (const base of ['', '<base href="/assets/">']) {
      const calls: string[] = []; const attribute = tag === 'object' ? 'data' : 'src';
      const link = base ? '../pluginfile.php/1/mod_resource/content/0/a.pdf' : '../../pluginfile.php/1/mod_resource/content/0/a.pdf';
      const backend = new BrowserBackend({ ...config(), setupConfirmed: true, courses: [{ id: 101, name: 'Example' }], requestIntervalMs: 0 });
      const internals = backend as unknown as { page: Page; session: () => Promise<BrowserContext> };
      internals.page = page;
      internals.session = async () => ({ request: { get: async (url: string) => {
        calls.push(url); const first = calls.length === 1;
        return { status: () => 200, headers: () => ({ 'content-type': first ? 'text/html' : 'application/pdf' }),
          url: () => first ? 'https://moodle.nottingham.ac.uk/mod/resource/view.php?id=999' : url,
          body: async () => Buffer.from(first ? base + '<main><' + tag + ' ' + attribute + '="' + link + '"></' + tag + '></main>' : '%PDF-test'), dispose: async () => {} };
      } } }) as unknown as BrowserContext;
      await backend.download(file, dir);
      assert.equal(calls[1], 'https://moodle.nottingham.ac.uk/pluginfile.php/1/mod_resource/content/0/a.pdf');
    }
  }
});
