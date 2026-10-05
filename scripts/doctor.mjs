import { access } from 'node:fs/promises';
const checks = [
  ['macOS', process.platform === 'darwin'],
  ['Node.js 24+', Number(process.versions.node.split('.')[0]) >= 24],
  ['Google Chrome', await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome').then(() => true, () => false)],
];
for (const [name, ok] of checks) console.log(`${ok ? 'OK' : 'MISSING'} ${name}`);
if (checks.some(([, ok]) => !ok)) {
  console.error('请先安装所缺环境。doctor 不修改系统或配置；Chrome 检测针对默认 /Applications 安装位置。');
  process.exitCode = 1;
}
