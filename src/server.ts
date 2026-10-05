import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { MoodleService } from './service.js';
import { failure } from './model.js';
import { selectCourses, confirmSetup } from './setup.js';

process.umask(0o077);
const service = new MoodleService();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.shutdown().finally(() => process.exit(0)); });
const server = new McpServer({ name: 'local-moodle-mcp', version: '0.4.2' }, {
  instructions: 'Read-only Moodle course materials. Download/sync only courses explicitly selected in the local courses.json configuration. External links are reported, never followed with school credentials. Before downloads, explicitly confirm the directory and course selection through setup. Manual one-shot sync only. Never submit assignments, send messages, change accounts, or expose credentials. NEEDS_LOGIN requires the user to run npm run login. Downloads keep old versions. Requests are serial and paced.',
});
const wrap = async (action: () => Promise<unknown>) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
  catch (e) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(failure(e)) }] }; }
};
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
server.registerTool('check_connection', { description: 'Check Moodle connection and dedicated login session; never return credentials.', inputSchema: z.object({}), annotations: read }, () => wrap(() => service.check()));
server.registerTool('list_courses', { description: 'List enrolled My Modules courses including hidden courses. Only explicitly approved IDs may be synchronized.', inputSchema: z.object({}), annotations: read }, () => wrap(() => service.courses()));
server.registerTool('list_resources', { description: 'List visible resources for an approved course, with observed IDs, titles, types and available format metadata.', inputSchema: z.object({ courseId: z.number().int().positive() }), annotations: read }, ({ courseId }) => wrap(() => service.resources(courseId)));
server.registerTool('download_resource', { description: 'Download a discovered file/folder module in an approved course to the approved materials directory. Keep old versions.', inputSchema: z.object({ courseId: z.number().int().positive(), moduleId: z.number().int().positive() }), annotations: write }, ({ courseId, moduleId }) => wrap(() => service.download(courseId, moduleId)));
server.registerTool('sync_courses', { description: 'Perform one manual incremental sync for the locally approved courses. mode quick downloads only unrecorded resources; full checks updates; organize refreshes readable local paths only. All modes refresh course/section layout. forceContentCheck requires full.', inputSchema: z.object({ forceContentCheck: z.boolean().optional(), mode: z.enum(['full', 'quick', 'organize']).optional() }), annotations: write }, ({ forceContentCheck, mode }) => wrap(() => service.sync(forceContentCheck, mode)));
server.registerTool('get_sync_settings', { description: 'Show approved course IDs and local output directories without authentication data.', inputSchema: z.object({}), annotations: { ...read, openWorldHint: false } }, () => wrap(async () => service.status()));
server.registerTool('select_courses', { description: 'After user approval, replace the local course selection with observed My Modules IDs. mode add preserves the existing selection and adds user-approved observed courses. Default replace with empty courseIds clears selection without deleting files. Local change only.', inputSchema: z.object({ courseIds: z.array(z.number().int().positive()).max(200), mode: z.enum(['replace', 'add']).optional() }), annotations: { ...write, openWorldHint: true } }, ({ courseIds, mode }) => wrap(() => selectCourses(service, courseIds, mode)));
server.registerTool('confirm_setup', { description: 'After explicit user confirmation of the displayed course list and current data root, persist setup approval. dataDir must match current settings. For a different root use npm run setup; this tool never migrates data.', inputSchema: z.object({ dataDir: z.string().min(1), confirmed: z.literal(true) }), annotations: { ...write, openWorldHint: false } }, ({ dataDir }) => wrap(() => confirmSetup(service, dataDir)));
await server.connect(new StdioServerTransport());
