import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

async function stat(path) {
  try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
export async function skillDestination({ home = homedir(), env = process.env } = {}) {
  if (env.CODEX_HOME) {
    if (!isAbsolute(env.CODEX_HOME)) throw new Error('CODEX_HOME must be an absolute path.');
    return join(env.CODEX_HOME, 'skills', 'unnc-moodle');
  }
  const current = join(home, '.agents', 'skills', 'unnc-moodle');
  const legacy = join(home, '.codex', 'skills', 'unnc-moodle');
  const [a, b] = await Promise.all([stat(current), stat(legacy)]);
  if (a && b) throw new Error('Duplicate unnc-moodle skills found in .agents and .codex. Review them before installing.');
  return b ? legacy : current;
}
async function safeParents(path) {
  const absolute = resolve(path); const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/)) {
    if (!part) continue;
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Refusing a symlink or non-directory skill path.');
  }
}
export async function installSkill({ home = homedir(), env = process.env,
  source = fileURLToPath(new URL('../skills/unnc-moodle/SKILL.md', import.meta.url)) } = {}) {
  const destination = await skillDestination({ home, env });
  const s = await lstat(source);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('Invalid bundled skill file.');
  const content = await readFile(source);
  await safeParents(dirname(destination));
  const lock = join(dirname(destination), '.unnc-moodle-install.lock');
  try { await writeFile(lock, '', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another skill install is active or interrupted. Inspect .unnc-moodle-install.lock before retrying.'); throw e; }
  let temporary;
  try {
    const old = await stat(destination);
    if (old) {
      if (!old.isDirectory() || old.isSymbolicLink()) throw new Error('Refusing an unsafe existing skill directory.');
      const file = await stat(join(destination, 'SKILL.md'));
      if (!file?.isFile() || file.isSymbolicLink()) throw new Error('Existing skill is incomplete or unsafe; it was not changed.');
      if (!(await readFile(join(destination, 'SKILL.md'))).equals(content)) throw new Error('Existing skill differs; it was not overwritten. Back it up outside the skills directory and review it before installing again.');
      return { installed: false, destination };
    }
    temporary = await mkdtemp(join(dirname(destination), '.unnc-moodle-install-'));
    await writeFile(join(temporary, 'SKILL.md'), content, { flag: 'wx', mode: 0o600 });
    if (await stat(destination)) throw new Error('Skill destination appeared during installation; it was not overwritten.');
    await rename(temporary, destination); temporary = undefined;
    return { installed: true, destination };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await rm(lock);
  }
}
export async function runInstaller(args = process.argv.slice(2)) {
  if (args.some(x => x !== '--yes')) throw new Error('Usage: npm run install-skill [-- --yes]');
  const destination = await skillDestination();
  console.log(`Codex skill 安装位置：${destination}`);
  console.log('安装后可直接说“同步我的 Moodle 课件”；无需每次明确调用 skill。已有不同版本不会覆盖。');
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) throw new Error('Interactive confirmation required. An authorized deployment can use npm run install-skill -- --yes.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('同时安装推荐的 Codex skill？[Y/n]：')).trim().toLowerCase();
      if (answer && answer !== 'y' && answer !== 'yes') { console.log('已跳过 skill；MCP 仍可使用。'); return; }
    } finally { rl.close(); }
  }
  const result = await installSkill();
  console.log(`${result.installed ? 'Skill 已安装' : '相同 Skill 已安装，无需重复安装'}：${result.destination}`);
  console.log('若 Codex 未显示 skill，请重启 Codex。MCP 仍需按 README 接入。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInstaller().catch(e => { console.error(e.message); process.exitCode = 1; });
}
