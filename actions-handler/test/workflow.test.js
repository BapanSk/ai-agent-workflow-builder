import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeStep } from '../src/workflow.js';

test('task step succeeds and reports attempt', async () => {
  const result = await executeStep(
    { type: 'task', name: 'Build', max_attempts: 2 },
    { name: 'Build', attempts: 2 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.output.task, 'Build');
  assert.equal(result.output.attempt, 2);
});

test('task step fails on first N attempts then succeeds', async () => {
  const stepDef = { type: 'task', max_attempts: 3, fail_first_n: 1 };
  assert.equal((await executeStep(stepDef, { attempts: 1 })).ok, false);
  assert.equal((await executeStep(stepDef, { attempts: 2 })).ok, true);
});

test('force_fail always fails', async () => {
  const stepDef = { type: 'task', force_fail: true, fail_message: 'boom' };
  const result = await executeStep(stepDef, { attempts: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
});

test('sleep step waits and reports duration', async () => {
  const result = await executeStep({ type: 'sleep', duration_seconds: 0 }, {});
  assert.equal(result.ok, true);
  assert.equal(result.output.waited_seconds, 0);
});

test('unknown step type errors', async () => {
  const result = await executeStep({ type: 'warp' }, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported step type/);
});
