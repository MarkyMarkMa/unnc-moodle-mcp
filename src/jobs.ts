import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MoodleError, type SyncSummary } from './model.js';
import { processAlive } from './operation.js';
import { privateDirectory, regularFile } from './safety.js';
import { writePrivateJson } from './setup.js';

const countsSchema = z.object({ added: z.number().int().nonnegative(), updated: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), remoteMissing: z.number().int().nonnegative() });
export function summaryCounts(summary: SyncSummary): z.infer<typeof countsSchema> {
  return { added: summary.added.length, updated: summary.updated.length, unchanged: summary.unchanged.length, failed: summary.failed.length, skipped: summary.skipped.length, remoteMissing: summary.remoteMissing.length };
}
export const emptyCounts = () => ({ added: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0, remoteMissing: 0 });
const failureSchema = z.object({ code: z.enum(['NEEDS_LOGIN', 'FORBIDDEN', 'NOT_FOUND', 'NETWORK', 'RATE_LIMITED', 'EXTERNAL_LINK', 'UNSUPPORTED', 'PARSE_FAILED', 'PROFILE_BUSY', 'BUSY', 'PATH_UNSAFE', 'FILE_TOO_LARGE', 'INVALID_INPUT', 'STATE_INVALID', 'LOCAL_IO', 'INTERNAL', 'SETUP_REQUIRED', 'STORAGE_CONFLICT']), message: z.string(), retryable: z.boolean(), attempts: z.number().int().positive().optional(), stage: z.enum(['discovery', 'download', 'commit', 'local', 'cleanup']).optional(), automaticRetryExhausted: z.boolean().optional() });
const entrySchema = z.object({ key: z.string(), path: z.string(), attempts: z.number().int().positive().optional() });
const summarySchema = z.object({ added: z.array(entrySchema), updated: z.array(entrySchema), unchanged: z.array(entrySchema.extend({ network: z.enum(['not_modified', 'content_checked']) })), failed: z.array(failureSchema.extend({ courseId: z.number().int().positive(), moduleId: z.number().int().positive().optional(), key: z.string().optional() })), skipped: z.array(z.object({ courseId: z.number().int().positive(), moduleId: z.number().int().positive(), title: z.string(), reason: z.string() })), remoteMissing: z.array(z.string()), needsLogin: z.boolean(), stoppedReason: z.enum(['NEEDS_LOGIN', 'RATE_LIMITED']).optional() });
const progressSchema = z.object({ stage: z.enum(['starting', 'discovery', 'listing', 'download', 'retry', 'organize', 'course_complete', 'finished']), totalCourses: z.number().int().nonnegative(), completedCourses: z.number().int().nonnegative(), discoveredResources: z.number().int().nonnegative(), processedFiles: z.number().int().nonnegative(), courseId: z.number().int().positive().optional(), moduleId: z.number().int().positive().optional(), title: z.string().optional(), key: z.string().optional(), attempt: z.number().int().positive().optional(), counts: countsSchema });
export type SyncProgress = z.infer<typeof progressSchema>;
export type ProgressReporter = (progress: Partial<SyncProgress>) => Promise<void>;
const taskSchema = z.object({ schemaVersion: z.literal(1), taskId: z.uuid(), pid: z.number().int().positive(), mode: z.enum(['quick', 'full', 'organize']), forceContentCheck: z.boolean(), status: z.enum(['running', 'completed', 'completed_with_errors', 'stopped', 'failed', 'interrupted']), startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), interruptionDetectedAt: z.iso.datetime().optional(), progress: progressSchema, summary: summarySchema.optional(), error: failureSchema.optional(), resultSaved: z.boolean().optional(), persistenceError: failureSchema.optional() });
export type SyncTask = z.infer<typeof taskSchema>;
export class JobStore {
  private readonly dir: string;
  constructor(private readonly stateDir: string) { this.dir = join(stateDir, 'sync-jobs'); }
  async save(task: SyncTask): Promise<void> {
    await privateDirectory(this.stateDir); await privateDirectory(this.dir);
    await writePrivateJson(join(this.dir, task.taskId + '.json'), taskSchema.parse(task));
  }
  async setLatest(taskId: string): Promise<void> { await writePrivateJson(join(this.stateDir, 'sync-latest.json'), { taskId: z.uuid().parse(taskId) }); }
  async read(taskId?: string): Promise<SyncTask | undefined> {
    if (!taskId) {
      const latest = await regularFile(this.stateDir, 'sync-latest.json');
      if (!latest) return;
      if ((await lstat(latest)).size > 4096) throw new MoodleError('STATE_INVALID');
      try { taskId = z.object({ taskId: z.uuid() }).parse(JSON.parse(await readFile(latest, 'utf8'))).taskId; }
      catch { throw new MoodleError('STATE_INVALID'); }
    }
    if (!z.uuid().safeParse(taskId).success) throw new MoodleError('INVALID_INPUT');
    const path = await regularFile(this.stateDir, 'sync-jobs/' + taskId + '.json');
    if (!path) return;
    if ((await lstat(path)).size > 32 * 1024 * 1024) throw new MoodleError('STATE_INVALID');
    try { const task = taskSchema.parse(JSON.parse(await readFile(path, 'utf8'))); if (task.taskId !== taskId) throw new Error(); return task; }
    catch { throw new MoodleError('STATE_INVALID'); }
  }
  async recover(taskId: string): Promise<void> {
    const task = await this.read(taskId);
    if (task?.status === 'running' && !processAlive(task.pid)) {
      task.status = 'interrupted'; task.interruptionDetectedAt = new Date().toISOString(); task.updatedAt = task.interruptionDetectedAt;
      await this.save(task);
    }
  }
}
export function taskView(task: SyncTask | undefined) {
  if (!task) return null;
  const view = structuredClone(task);
  if (view.status === 'running' && !processAlive(view.pid)) { view.status = 'interrupted'; view.interruptionDetectedAt ??= new Date().toISOString(); }
  const elapsedMs = Math.max(0, Date.parse(view.finishedAt ?? view.interruptionDetectedAt ?? new Date().toISOString()) - Date.parse(view.startedAt));
  const sinceProgressMs = Math.max(0, Date.now() - Date.parse(view.updatedAt));
  return { ...view, elapsedMs, sinceProgressMs, awaitingProgress: view.status === 'running' && sinceProgressMs >= 90_000 };
}
