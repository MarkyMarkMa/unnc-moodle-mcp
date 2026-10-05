export const MOODLE_ORIGIN = 'https://moodle.nottingham.ac.uk';
export interface SelectedCourse { id: number; name: string; }

export type ErrorCode = 'NEEDS_LOGIN' | 'FORBIDDEN' | 'NOT_FOUND' | 'NETWORK' | 'RATE_LIMITED' |
  'EXTERNAL_LINK' | 'UNSUPPORTED' | 'PARSE_FAILED' | 'PROFILE_BUSY' | 'BUSY' |
  'PATH_UNSAFE' | 'FILE_TOO_LARGE' | 'INVALID_INPUT' | 'STATE_INVALID' | 'LOCAL_IO' | 'INTERNAL' | 'SETUP_REQUIRED';
const messages: Record<ErrorCode, string> = {
  NEEDS_LOGIN: '专用会话未登录或已过期，请运行 npm run login 亲自重新认证。',
  FORBIDDEN: '账户没有访问该资源的权限。', NOT_FOUND: '远端资源已不存在。',
  NETWORK: '网络请求失败，可稍后重试。', RATE_LIMITED: '网站要求降低请求频率，请稍后重试。',
  EXTERNAL_LINK: '资源指向外部域名；已停止，不会携带学校凭据访问。',
  UNSUPPORTED: '第一版不支持自动下载这种资源。', PARSE_FAILED: '页面结构或资源类型无法可靠识别。',
  PROFILE_BUSY: '专用浏览器配置正在使用，请先关闭登录窗口或另一个 MCP 进程。',
  BUSY: '另一个同步或浏览器操作正在进行，请稍后重试。',
  PATH_UNSAFE: '本地路径或远端文件名不安全，操作已停止。',
  FILE_TOO_LARGE: '资源超出配置的最大下载大小。', INVALID_INPUT: '参数不合法或课程未获批准。',
  SETUP_REQUIRED: '请运行 npm run setup，确认本地目录与课程名单后再下载或同步。',
  LOCAL_IO: '本地文件操作失败；请检查磁盘空间和访问权限后再调用。',
  INTERNAL: '内部操作失败；请检查程序或联系维护者。',
  STATE_INVALID: '同步状态损坏或结构不合法；已停止，未覆盖原状态。',
};
export type ErrorStage = 'discovery' | 'download' | 'commit' | 'local' | 'cleanup';
export class MoodleError extends Error {
  constructor(public readonly code: ErrorCode, public attempts?: number, public stage?: ErrorStage, public automaticRetryExhausted?: boolean) { super(messages[code]); }
}
export function atStage(error: unknown, stage: ErrorStage): MoodleError {
  if (error instanceof MoodleError) { error.stage ??= stage; return error; }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new MoodleError(typeof code === 'string' && /^(EACCES|EPERM|ENOSPC|EIO|EROFS|ENOENT|ENOTDIR|EISDIR|EMFILE|ENFILE|EXDEV|EDQUOT)$/.test(code) ? 'LOCAL_IO' : 'INTERNAL', undefined, stage);
}
export interface Failure {
  code: ErrorCode; message: string;
  /** A later manual call may help; does not authorize automatic retries. */
  retryable: boolean; attempts?: number; stage?: ErrorStage; automaticRetryExhausted?: boolean;
}
export function failure(error: unknown, stage?: ErrorStage): Failure {
  const e = atStage(error, stage ?? 'local');
  return { code: e.code, message: e.message, stage: e.stage,
    ...(e.attempts ? { attempts: e.attempts } : {}),
    ...(e.automaticRetryExhausted !== undefined ? { automaticRetryExhausted: e.automaticRetryExhausted } : {}),
    retryable: ['NETWORK', 'RATE_LIMITED', 'BUSY', 'PROFILE_BUSY'].includes(e.code) };
}
export interface Course { id: number; name: string; selected: boolean; hidden?: boolean; }
export type ResourceType = 'file' | 'folder' | 'url' | 'page' | 'book' | 'unsupported';
export interface Resource {
  courseId: number; moduleId: number; title: string; type: ResourceType; url: string;
  format?: string; modifiedAt?: string;
  sectionName?: string;
}
export interface RemoteFile {
  courseId: number; moduleId: number; key: string; title: string; url: string;
  remotePath: string; filename?: string;
  sectionName?: string;
  /** Nested directories inside a published Moodle folder, excluding its title and filename. */
  relativeFolder?: string;
}
export interface DownloadResult {
  attempts?: number;
  kind: 'downloaded' | 'not_modified'; stagingPath?: string; filename?: string;
  sha256?: string; bytes?: number; mime?: string; etag?: string; lastModified?: string;
}
export interface Backend {
  checkConnection(): Promise<{ connected: boolean; authenticated: boolean; needsLogin: boolean }>;
  listCourses(): Promise<Course[]>;
  listResources(courseId: number): Promise<Resource[]>;
  listFiles(resource: Resource): Promise<RemoteFile[]>;
  download(file: RemoteFile, stagingDir: string, previous?: StoredFile, force?: boolean): Promise<DownloadResult>;
  close(): Promise<void>;
}
export interface Version { version: number; relativePath: string; filename: string; sha256: string; bytes: number; savedAt: string; }
export interface StoredFile {
  key: string; courseId: number; moduleId: number; remotePath: string; title: string;
  etag?: string; lastModified?: string; mime?: string; present: boolean; lastCheckedAt: string; versions: Version[];
  readablePath?: string; readableHash?: string; readableFilename?: string;
}
export interface Manifest { schemaVersion: 1; files: Record<string, StoredFile>; }
export interface SyncSummary {
  added: Array<{ key: string; path: string; attempts?: number }>;
  updated: Array<{ key: string; path: string; attempts?: number }>;
  unchanged: Array<{ key: string; path: string; network: 'not_modified' | 'content_checked'; attempts?: number }>;
  failed: Array<Failure & { courseId: number; moduleId?: number; key?: string }>;
  skipped: Array<{ courseId: number; moduleId: number; title: string; reason: string }>;
  remoteMissing: string[];
  needsLogin: boolean;
  stoppedReason?: 'NEEDS_LOGIN' | 'RATE_LIMITED';
}
