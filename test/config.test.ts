import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCourses, approvedCourse } from '../src/config.js';
import { parseCourses } from '../src/parser.js';

test('new users default to no approved courses; independent lists authorize only selected IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodle-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'courses.json'); assert.deepEqual(loadCourses(path), []);
  await writeFile(path, JSON.stringify([{ id: 808, name: 'Other student course' }]));
  const courses = loadCourses(path); approvedCourse(808, courses);
  await writeFile(path, JSON.stringify([{ id: 909, name: 'Changed semester' }]));
  assert.equal(courses[0]?.id, 808); assert.equal(loadCourses(path)[0]?.id, 909);
  // Existing process snapshots stay stable; a new startup reads the changed list.
  assert.throws(() => approvedCourse(101, courses)); assert.throws(() => approvedCourse(808, []));
  assert.equal(parseCourses([{ href: '/course/view.php?id=808', text: 'Other student course' }], false, courses)[0]?.selected, true);
  assert.equal(parseCourses([{ href: '/course/view.php?id=808', text: 'Other student course' }])[0]?.selected, false);
  for (const value of ['{broken', '[{"id":808,"name":"A"},{"id":808,"name":"B"}]', '[{"id":-1,"name":"A"}]', '[{"id":808,"name":""}]', '{}']) {
    await writeFile(path, value); assert.throws(() => loadCourses(path));
  }
  await rm(path); await symlink(join(root, 'missing'), path); assert.throws(() => loadCourses(path));
});
