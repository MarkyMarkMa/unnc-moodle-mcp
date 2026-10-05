import { homedir } from 'node:os';
import { posix, win32, relative, resolve, isAbsolute, sep } from 'node:path';

export function applicationDirectory(platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'moodle-mcp');
  return posix.join(home, 'Library', 'Application Support', 'moodle-mcp');
}

// Relative-path checks use the host filesystem semantics, including Windows drives.
export function contained(root: string, candidate: string): boolean {
  const diff = relative(resolve(root), resolve(candidate));
  return diff === '' || (!isAbsolute(diff) && diff !== '..' && !diff.startsWith('..' + sep));
}
