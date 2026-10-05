import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
test('official MCP client discovers tools and invokes actual server with validation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodle-client-')); t.after(() => rm(root, { recursive: true, force: true }));
  const coursesFile = join(root, 'courses.json');
  await writeFile(coursesFile, JSON.stringify([{ id: 808, name: 'Other student course' }]));
  const transport = new StdioClientTransport({ command: process.execPath, env: { ...Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => x[1] !== undefined)), MOODLE_COURSES_FILE: coursesFile, MOODLE_DATA_DIR: root, MOODLE_SETTINGS_FILE: join(root, 'settings.json') }, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))] });
  const client = new Client({ name: 'moodle-test-client', version: '0.1.0' });
  try {
    await client.connect(transport); const list = await client.listTools();
    assert.deepEqual(list.tools.map(t => t.name).sort(), ['confirm_setup', 'select_courses', 'check_connection', 'download_resource', 'get_sync_settings', 'list_courses', 'list_resources', 'sync_courses'].sort());
    const result = await client.callTool({ name: 'get_sync_settings', arguments: {} });
    assert.equal(result.isError, undefined); assert.match(JSON.stringify(result), /Other student course/);
    const blocked = await client.callTool({ name: 'sync_courses', arguments: {} });
    assert.equal(blocked.isError, true); assert.match(JSON.stringify(blocked), /SETUP_REQUIRED/);
    const wrongDirectory = await client.callTool({ name: 'confirm_setup', arguments: { dataDir: join(root, 'other'), confirmed: true } });
    assert.equal(wrongDirectory.isError, true);
    const confirmed = await client.callTool({ name: 'confirm_setup', arguments: { dataDir: root, confirmed: true } });
    assert.equal(confirmed.isError, undefined);
    const cleared = await client.callTool({ name: 'select_courses', arguments: { courseIds: [] } });
    assert.equal(cleared.isError, undefined);
    const settings = await client.callTool({ name: 'get_sync_settings', arguments: {} });
    assert.match(JSON.stringify(settings), /readyToSync/);
    const denied = await client.callTool({ name: 'list_resources', arguments: { courseId: 42 } });
    assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /INVALID_INPUT/);
  } finally { await client.close(); }
});
