import { access } from 'node:fs/promises';
import { join } from 'node:path';
const candidates = process.platform === 'win32'
  ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const found = await Promise.all(candidates.map(path => access(path).then(() => true, () => false)));
const checks = [
  ['macOS / Windows', ['darwin', 'win32'].includes(process.platform)],
  ['Node.js 24+', Number(process.versions.node.split('.')[0]) >= 24],
  [process.platform === 'win32' ? 'Microsoft Edge' : 'Google Chrome', found.some(Boolean)],
];
for (const [name, ok] of checks) console.log(`${ok ? 'OK' : 'MISSING'} ${name}`);
if (checks.some(([, ok]) => !ok)) {
  console.error('请先安装所缺环境。doctor 不修改系统或配置；仅检查所需浏览器的标准安装位置（Windows Edge / macOS Chrome）。');
  process.exitCode = 1;
}
