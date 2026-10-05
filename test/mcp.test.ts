import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, mkdir, rm, writeFile, cp, symlink, readFile } from 'node:fs/promises';
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
    assert.deepEqual(list.tools.map(t => t.name).sort(), ['login', 'configure_organization', 'confirm_setup', 'select_courses', 'check_connection', 'download_resource', 'get_sync_settings', 'list_courses', 'list_resources', 'sync_courses'].sort());
    const loginTool = list.tools.find(t => t.name === 'login')!;
    assert.equal(loginTool.annotations?.readOnlyHint, false);
    assert.equal(loginTool.annotations?.idempotentHint, false);
    const result = await client.callTool({ name: 'get_sync_settings', arguments: {} });
    assert.equal(result.isError, undefined); assert.match(JSON.stringify(result), /Other student course/);
    const organize = await client.callTool({ name: 'sync_courses', arguments: { mode: 'organize' } });
    assert.equal(organize.isError, true); assert.match(JSON.stringify(organize), /SETUP_REQUIRED/);
    const incompatible = await client.callTool({ name: 'sync_courses', arguments: { mode: 'organize', forceContentCheck: true } });
    assert.equal(incompatible.isError, true);
    const blocked = await client.callTool({ name: 'sync_courses', arguments: {} });
    assert.equal(blocked.isError, true); assert.match(JSON.stringify(blocked), /SETUP_REQUIRED/);
    const wrongDirectory = await client.callTool({ name: 'confirm_setup', arguments: { dataDir: join(root, 'other'), confirmed: true } });
    assert.equal(wrongDirectory.isError, true);
    const confirmed = await client.callTool({ name: 'confirm_setup', arguments: { dataDir: root, confirmed: true } });
    assert.equal(confirmed.isError, undefined);
    const existing = join(root, 'existing'); await mkdir(join(existing, 'Seminar'), { recursive: true });
    const configured = await client.callTool({ name: 'configure_organization', arguments: { organization: { mode: 'existing', root: existing, rules: [{ courseId: 808, directory: 'Seminar', keywords: ['seminar'] }] }, confirmed: true } });
    assert.equal(configured.isError, undefined, JSON.stringify(configured)); assert.match(JSON.stringify(configured), /restartMcpRequired/);
    const noConfirmation = await client.callTool({ name: 'configure_organization', arguments: { organization: { mode: 'managed' }, confirmed: false } });
    assert.equal(noConfirmation.isError, true);
    const unsafeRule = await client.callTool({ name: 'configure_organization', arguments: { organization: { mode: 'existing', root: existing, rules: [{ courseId: 808, directory: '../escape', keywords: ['seminar'] }] }, confirmed: true } });
    assert.equal(unsafeRule.isError, true);
    assert.match(JSON.stringify(await client.callTool({ name: 'get_sync_settings', arguments: {} })), /Seminar/);
    const cleared = await client.callTool({ name: 'select_courses', arguments: { courseIds: [] } });
    assert.equal(cleared.isError, undefined);
    const settings = await client.callTool({ name: 'get_sync_settings', arguments: {} });
    assert.match(JSON.stringify(settings), /readyToSync/);
    const denied = await client.callTool({ name: 'list_resources', arguments: { courseId: 42 } });
    assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /INVALID_INPUT/);
  } finally { await client.close(); }
});

test('stdio startup migrates legacy storage and reports preserved confirmation with new paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodle-migrated-client-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { mkdir, readFile } = await import('node:fs/promises');
  await mkdir(join(root, 'state')); await mkdir(join(root, 'materials'));
  await writeFile(join(root, 'state', 'manifest.json'), '{"schemaVersion":1,"files":{}}');
  await writeFile(join(root, 'materials', 'note.txt'), 'personal note');
  await writeFile(join(root, 'courses.json'), '[{"id":808,"name":"Example course"}]');
  const settingsFile = join(root, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ schemaVersion: 1, confirmed: true, dataDir: root, coursesFile: join(root, 'courses.json') }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => x[1] !== undefined)), MOODLE_DATA_DIR: root, MOODLE_SETTINGS_FILE: settingsFile };
  delete (env as Record<string, string>).MOODLE_COURSES_FILE;
  const client = new Client({ name: 'migration-test-client', version: '0.1.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, env, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))] }));
    assert.equal((await client.listTools()).tools.length, 10);
    const response = await client.callTool({ name: 'get_sync_settings', arguments: {} });
    assert.equal(response.isError, undefined);
    const settings = JSON.parse((response.content as Array<{text:string}>)[0]!.text);
    assert.equal(settings.setupConfirmed, true); assert.equal(settings.readyToSync, true);
    assert.equal(settings.coursesFile, join(root, '_moodle', 'courses.json')); assert.equal(settings.directories.state, join(root, '_moodle', 'state'));
    assert.equal(await readFile(join(root, 'materials', 'note.txt'), 'utf8'), 'personal note');
  } finally { await client.close(); }
});


test('stdio login launches the dedicated script without leaking stdout and reports unfinished authentication', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodle-login-client-')); t.after(() => rm(root, { recursive: true, force: true }));
  const program = join(root, 'program'); await mkdir(join(program, 'scripts'), { recursive: true });
  await cp(fileURLToPath(new URL('../src', import.meta.url)), join(program, 'dist/src'), { recursive: true });
  await writeFile(join(program, 'package.json'), '{"type":"module"}');
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(program, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const marker = join(root, 'launched.txt'); const profile = join(root, 'profile');
  await writeFile(join(program, 'scripts/login.mjs'), `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, process.env.MOODLE_PROFILE_DIR); console.log('must not enter MCP stdout');`);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => x[1] !== undefined)), MOODLE_DATA_DIR: join(root, 'data'), MOODLE_SETTINGS_FILE: join(root, 'settings.json'), MOODLE_PROFILE_DIR: profile, MOODLE_COURSES_FILE: join(root, 'courses.json') };
  const client = new Client({ name: 'login-client', version: '0.1.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, env, args: [join(program, 'dist/src/server.js')] }));
    const result = await client.callTool({ name: 'login', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse((result.content as Array<{text:string}>)[0]!.text), { connected: true, authenticated: false, needsLogin: true });
    assert.equal(await readFile(marker, 'utf8'), profile);
    assert.equal((await client.callTool({ name: 'check_connection', arguments: {} })).isError, undefined);
  } finally { await client.close(); }
});
