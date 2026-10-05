import { chromium } from 'playwright';
import { mkdir, chmod, writeFile, rename, lstat } from 'node:fs/promises';
import { applicationDirectory } from '../dist/src/platform.js';
import { join, dirname, isAbsolute } from 'node:path';

// This profile belongs only to this project; never copy a personal Chrome profile.
const root = applicationDirectory();
const profile = process.env.MOODLE_PROFILE_DIR ?? join(root, 'browser-profile');
process.umask(0o077);
if (!isAbsolute(profile)) throw new Error('Profile must be an absolute path');
await mkdir(profile, { recursive: true, mode: 0o700 });
if ((await lstat(profile)).isSymbolicLink()) throw new Error('Refusing symlink profile directory');
if (dirname(profile) === root) await chmod(root, 0o700);
await chmod(profile, 0o700);
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: false, acceptDownloads: false, chromiumSandbox: true,
});
const page = context.pages()[0] ?? await context.newPage();
let stop = false;
context.on('close', () => { stop = true; });
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
try {
  await page.goto('https://moodle.nottingham.ac.uk/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.error('专用 Moodle 浏览器已打开。请亲自登录并完成 MFA；程序不会读取或填写密码。');
  while (!stop) {
    const u = new URL(page.url());
    if (u.origin === 'https://moodle.nottingham.ac.uk' && !/^\/(login|auth)\//.test(u.pathname)) {
      const modules = await page.getByText('My Modules', { exact: true }).count().catch(() => 0);
      if (modules > 0) {
        // Chrome discards session cookies on a clean shutdown. Persist only this
        // dedicated Moodle session, never Microsoft's cookies or a personal profile.
        const state = await context.storageState();
        const cookies = state.cookies.filter(c => c.domain.replace(/^\./, '') === 'moodle.nottingham.ac.uk');
        if (!cookies.length) { await new Promise(resolve => setTimeout(resolve, 1500)); continue; }
        const temporary = join(profile, 'moodle-session.json.tmp');
        await writeFile(temporary, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, join(profile, 'moodle-session.json'));
        console.error('已验证登录并保存仅限 Moodle 的专用会话，浏览器将自动关闭。');
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
} finally {
  await context.close().catch(() => {});
}
