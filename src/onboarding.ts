import { browserName } from './platform.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { isAbsolute, resolve } from 'node:path';
// @ts-ignore Standalone installer is shared by macOS and Windows.
import { runInstaller } from '../../scripts/install-skill.mjs';
import { config } from './config.js';
import { MoodleService } from './service.js';
import { MoodleError } from './model.js';
import { confirmSetup, selectCourses, configureOrganization } from './setup.js';

export async function onboarding(login: () => Promise<number>): Promise<void> {
  if (!stdin.isTTY) throw new MoodleError('INVALID_INPUT');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log('UNNC Moodle 首次设置：只读访问；不会自动开始同步。');
    const initial = config();
    const directory = (await rl.question(`资料根目录 [${initial.dataDir}]：`)).trim() || initial.dataDir;
    if (!isAbsolute(directory)) throw new MoodleError('INVALID_INPUT');
    if (resolve(directory) !== resolve(initial.dataDir)) {
      console.log('更换根目录不会迁移旧资料；旧资料保留。已有用户迁移请先参阅 README。');
    }
    process.env.MOODLE_DATA_DIR = resolve(directory);
    // An explicit MOODLE_COURSES_FILE remains authoritative; disclose it in summary.
    const service = new MoodleService(config());
    let check;
    try { check = await service.check(); }
    catch (e) { if (!(e instanceof MoodleError) || e.code !== 'NEEDS_LOGIN') throw e; }
    if (!check?.authenticated) {
      const answer = await rl.question(`打开专用 ${browserName()}，由你亲自登录并完成 MFA？输入 yes：`);
      if (answer.trim().toLowerCase() !== 'yes') return;
      if (await login() !== 0) throw new MoodleError('NEEDS_LOGIN');
      const verified = await service.check();
      if (!verified.authenticated) throw new MoodleError('NEEDS_LOGIN');
    }
    const courses = await service.courses();
    courses.forEach((c, i) => console.log(`${i + 1}. ${c.name}${c.selected ? ' [已选]' : ''}`));
    if (!courses.length) { console.log('未发现课程。未完成设置，请稍后重试。'); return; }
    const answer = await rl.question('输入需要同步的课程序号，以逗号分隔（例如 1,3）；留空取消：');
    if (!answer.trim()) return;
    const indexes = answer.split(',').map(v => Number(v.trim()));
    if (indexes.some(i => !Number.isSafeInteger(i) || i < 1 || i > courses.length) || new Set(indexes).size !== indexes.length) throw new MoodleError('INVALID_INPUT');
    const chosen = indexes.map(i => courses[i - 1]!);
    const mode = (await rl.question('保存方式：1 按课程/栏目自动建目录；2 合并到已有分类文件夹 [1]：')).trim() || '1';
    if (!['1', '2'].includes(mode)) throw new MoodleError('INVALID_INPUT');
    const existingRoot = mode === '2' ? (await rl.question('已有课程文件夹共同的根目录（绝对路径）：')).trim() : undefined;
    if (mode === '2' && (!existingRoot || !isAbsolute(existingRoot))) throw new MoodleError('INVALID_INPUT');
    if (mode === '2') console.log('分类规则稍后在 Codex 中确认；确认前不下载未分类资料。已有文件不会被自动接管或迁移。');
    console.log(JSON.stringify({ courses: chosen.map(c => c.name), materials: service.cfg.materialsDir, organization: mode === '2' ? { mode: 'existing', root: existingRoot } : { mode: 'managed' }, coursesFile: service.cfg.coursesFile, keepOldVersions: true, manualSyncOnly: true }, null, 2));
    if ((await rl.question('确认保存这份设置？输入 yes：')).trim().toLowerCase() !== 'yes') return;
    await selectCourses(service, chosen.map(c => c.id));
    await configureOrganization(service, mode === '2' ? { mode: 'existing', root: resolve(existingRoot!), rules: [] } : { mode: 'managed' });
    await confirmSetup(service, service.cfg.dataDir);
    rl.close();
    try { await runInstaller([]); }
    catch (e) { console.error(`Skill 未安装：${(e as Error).message} 可稍后运行 npm run install-skill；MCP 设置已保存。`); }
    console.log('设置完成。运行 npm run sync，或在 Codex 中说“同步我的 Moodle 课件”。现有 MCP 进程需重启以读取新目录。');
  } finally { rl.close(); }
}
