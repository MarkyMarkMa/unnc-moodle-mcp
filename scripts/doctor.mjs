import { access } from 'node:fs/promises';
import { join } from 'node:path';
const candidates = process.platform === 'win32'
  ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const found = await Promise.all(candidates.map(path => access(path).then(() => true, () => false)));
const checks = [
  ['macOS / Windows', ['darwin', 'win32'].includes(process.platform)],
  ['Node.js 24+', Number(process.versions.node.split('.')[0]) >= 24],
  ['Google Chrome', found.some(Boolean)],
];
for (const [name, ok] of checks) console.log(`${ok ? 'OK' : 'MISSING'} ${name}`);
if (checks.some(([, ok]) => !ok)) {
  console.error('请先安装所缺环境。doctor 不修改系统或配置；仅检查 Chrome 的标准安装位置。');
  process.exitCode = 1;
}
