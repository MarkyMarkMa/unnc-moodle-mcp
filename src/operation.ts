import { constants } from 'node:fs';
import { lstat, open, readFile, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MoodleError } from './model.js';
import { privateDirectory, regularFile } from './safety.js';

const schema = z.object({ pid: z.number().int().positive(), token: z.string().min(1).max(100), startedAt: z.iso.datetime(), operation: z.string().max(100).optional(), taskId: z.uuid().optional() });
export type Operation = z.infer<typeof schema>;
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function inspectOperation(stateDir: string) {
  const path = await regularFile(stateDir, 'operation.lock');
  if (!path) return { state: 'idle' as const };
  try {
    const stat = await lstat(path);
    if (stat.size > 4096) throw new MoodleError('STATE_INVALID');
    const text = await readFile(path, 'utf8');
    let operation: Operation;
    try { operation = schema.parse(JSON.parse(text)); }
    catch { throw new MoodleError('STATE_INVALID'); }
    return { state: processAlive(operation.pid) ? 'active' as const : 'stale' as const, ...operation };
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'idle' as const }; throw e; }
}
async function guardPresent(stateDir: string): Promise<boolean> {
  return !!await regularFile(stateDir, 'operation-recovery.lock');
}
export async function releaseOperation(stateDir: string, owned: Operation): Promise<void> {
  const current = await inspectOperation(stateDir);
  if (current.state !== 'idle' && current.token === owned.token && current.pid === owned.pid) await unlink(join(stateDir, 'operation.lock'));
}
export async function acquireOperation(stateDir: string, operation: string, taskId?: string): Promise<{ owned: Operation; recovered?: Operation }> {
  await privateDirectory(stateDir);
  if (await guardPresent(stateDir)) throw new MoodleError('BUSY');
  let recovered: Operation | undefined;
  const old = await inspectOperation(stateDir);
  if (old.state === 'stale') {
    // Serialize stale-lock recovery. Acquirers check this guard both before and
    // after creating the operation lock, so recovery cannot remove a new owner.
    const guardPath = join(stateDir, 'operation-recovery.lock');
    let guard;
    try { guard = await open(guardPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new MoodleError('BUSY'); throw e; }
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      const current = await inspectOperation(stateDir);
      if (current.state === 'stale') { recovered = current; await unlink(join(stateDir, 'operation.lock')); }
      else if (current.state === 'active') throw new MoodleError('BUSY');
    } finally { await guard.close(); await unlink(guardPath); }
  }
  const owned: Operation = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString(), operation, ...(taskId ? { taskId } : {}) };
  const temporary = join(stateDir, 'operation-' + owned.token + '.tmp');
  const h = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(JSON.stringify(owned)); await h.sync(); await h.close();
    // Publish fully written lock bytes atomically, so concurrent status queries
    // never mistake a lock still being written for corrupt JSON.
    try { await link(temporary, join(stateDir, 'operation.lock')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new MoodleError('BUSY'); throw e; }
  } finally { await h.close().catch(() => {}); await unlink(temporary); }
  if (await guardPresent(stateDir)) { await releaseOperation(stateDir, owned); throw new MoodleError('BUSY'); }
  return { owned, recovered };
}
