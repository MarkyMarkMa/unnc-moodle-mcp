import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MoodleService } from './service.js';
import { failure, MoodleError } from './model.js';
import { onboarding } from './onboarding.js';
import { selectCourses } from './setup.js';
process.umask(0o077);
async function login(): Promise<number> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/login.mjs', import.meta.url))], { stdio: 'inherit' });
  return new Promise(resolve => { child.on('error', () => resolve(1)); child.on('exit', c => resolve(c ?? 1)); });
}
try {
  const command = process.argv[2];
  if (command === 'login') process.exitCode = await login();
  else if (command === 'setup') await onboarding(login);
  else if (command === 'codex-config') {
    console.log('[mcp_servers.moodle_local]\ncommand = ' + JSON.stringify(process.execPath) + '\nargs = [' + JSON.stringify(fileURLToPath(new URL('./server.js', import.meta.url))) + ']\nenabled = true\nstartup_timeout_sec = 30\ntool_timeout_sec = 600');
  }
  else {
    const service = new MoodleService();
    let result;
    if (command === 'select') {
      const args = process.argv.slice(3);
      if (!args.length) throw new MoodleError('INVALID_INPUT');
      result = await selectCourses(service, args.length === 1 && args[0] === '--clear' ? [] : args.map(Number));
    } else result = command === 'check' ? await service.check() : command === 'courses' ? await service.courses() : command === 'resources' ? await service.resources(Number(process.argv[3])) : command === 'sync' ? await service.sync(process.argv.includes('--force')) : command === 'settings' ? service.status() : (() => { throw new MoodleError('INVALID_INPUT'); })();
    console.log(JSON.stringify(result, null, 2));
  }
} catch (e) { console.error(JSON.stringify(failure(e))); process.exitCode = 1; }
