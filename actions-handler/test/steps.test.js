import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { executeStep, normalizeStepType, hasRestrictedSteps } from '../src/workflow.js';

function makeContext(overrides = {}) {
  return {
    input: { app: 'checkout', risk: 'critical' },
    outputs: [null, { severity: 'critical' }],
    steps: { 'Assess release risk': { severity: 'critical' } },
    env: { HANDLER_BASE_URL: 'http://localhost:4000' },
    run: {
      id: 'run-1',
      workflow_id: 'wf-1',
      organization_id: 'org-1',
    },
    client: null,
    ...overrides,
  };
}

test('condition step evaluates an expression', async () => {
  const ctx = makeContext();
  const ok = await executeStep(
    { type: 'condition', expression: "steps['Assess release risk'].severity == 'critical'" },
    { name: 'Requires approval?', attempts: 1 },
    ctx,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.output.result, true);
});

test('condition step with invalid expression fails', async () => {
  const ctx = makeContext();
  const bad = await executeStep(
    { type: 'condition', expression: 'input..broken' },
    { name: 'bad', attempts: 1 },
    ctx,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid condition expression/);
});

test('llm step simulates deterministically without an API key', async () => {
  const ctx = makeContext();
  const ok = await executeStep(
    { type: 'llm', prompt: 'Assess risk for {{input.app}} ({{input.risk}})', model: 'demo' },
    { name: 'Assess release risk', attempts: 1 },
    ctx,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.output.simulated, true);
  assert.equal(ok.output.severity, 'critical');
  assert.match(ok.output.summary, /critical/);
});

test('llm step simulates low risk for non-critical input', async () => {
  const ctx = makeContext({ input: { app: 'checkout', risk: 'low' } });
  const ok = await executeStep(
    { type: 'llm', prompt: 'Assess risk' },
    { name: 'Assess', attempts: 1 },
    ctx,
  );
  assert.equal(ok.output.severity, 'low');
});

test('http step performs a GET and parses JSON body', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'demo-api' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ok = await executeStep(
      { type: 'http', method: 'GET', url: `http://127.0.0.1:${port}/demo/status` },
      { name: 'Check deployment status', attempts: 1 },
      makeContext(),
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.output.status, 200);
    assert.deepEqual(ok.output.body, { status: 'ok', service: 'demo-api' });
  } finally {
    server.close();
  }
});

test('http step rejects non-http(s) urls', async () => {
  const ok = await executeStep(
    { type: 'http', url: 'file:///etc/passwd' },
    { name: 'bad url', attempts: 1 },
    makeContext(),
  );
  assert.equal(ok.ok, false);
  assert.match(ok.error, /only supports http/);
});

test('http step surfaces upstream errors', async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ok = await executeStep(
      { type: 'http', url: `http://127.0.0.1:${port}/` },
      { name: 'upstream', attempts: 1 },
      makeContext(),
    );
    assert.equal(ok.ok, false);
    assert.match(ok.error, /HTTP 503/);
  } finally {
    server.close();
  }
});

function fakeClient() {
  const inserts = [];
  return {
    inserts,
    async query(sql, params) {
      if (sql.includes('INSERT INTO')) inserts.push({ sql, params });
      return { rows: [{ id: 'event-1' }] };
    },
  };
}

test('db_write step inserts into workflow_events with org/run/workflow ids', async () => {
  const client = fakeClient();
  const ctx = makeContext({ client });
  const ok = await executeStep(
    {
      type: 'db_write',
      table: 'workflow_events',
      event_type: 'release.assessed',
      data: { app: '{{input.app}}', severity: "{{steps['Assess release risk'].severity}}" },
    },
    { name: 'Persist event', attempts: 1 },
    ctx,
  );
  assert.equal(ok.ok, true);
  assert.equal(client.inserts.length, 1);
  const { sql, params } = client.inserts[0];
  assert.match(sql, /workflow_events/);
  assert.deepEqual(params, ['org-1', 'run-1', 'wf-1', 'release.assessed', '{"app":"checkout","severity":"critical"}']);
});

test('db_write step rejects non-allow-listed tables', async () => {
  const ctx = makeContext({ client: fakeClient() });
  const ok = await executeStep(
    { type: 'db_write', table: 'users', data: {} },
    { name: 'hax', attempts: 1 },
    ctx,
  );
  assert.equal(ok.ok, false);
  assert.match(ok.error, /not allow-listed/);
});

test('notify step inserts into notifications', async () => {
  const client = fakeClient();
  const ctx = makeContext({ client });
  const ok = await executeStep(
    { type: 'notify', title: 'Release {{input.app}} assessed', body: 'Severity {{outputs[1].severity}}' },
    { name: 'Notify team', attempts: 1 },
    ctx,
  );
  assert.equal(ok.ok, true);
  assert.equal(client.inserts.length, 1);
  const { sql, params } = client.inserts[0];
  assert.match(sql, /notifications/);
  assert.deepEqual(params, ['org-1', 'run-1', 'wf-1', 'Release checkout assessed', 'Severity critical']);
});

test('legacy step-type aliases normalize to the assignment vocabulary', () => {
  assert.equal(normalizeStepType('llm'), 'llm_call');
  assert.equal(normalizeStepType('http'), 'http_request');
  assert.equal(normalizeStepType('condition'), 'conditional_branch');
  assert.equal(normalizeStepType('approval'), 'approval_gate');
  assert.equal(normalizeStepType('llm_call'), 'llm_call');
  assert.equal(normalizeStepType('task'), 'task');
  assert.equal(normalizeStepType('db_write'), 'db_write');
});

test('hasRestrictedSteps flags db_write/notify anywhere in the workflow', () => {
  assert.equal(hasRestrictedSteps([{ type: 'task' }, { type: 'llm_call' }]), false);
  assert.equal(hasRestrictedSteps([{ type: 'task' }, { type: 'db_write' }]), true);
  assert.equal(hasRestrictedSteps([{ type: 'notify' }]), true);
  assert.equal(hasRestrictedSteps([{ type: 'approval_gate' }]), false);
});

test('canonical llm_call type executes the llm step', async () => {
  const ctx = makeContext();
  const ok = await executeStep(
    { type: 'llm_call', prompt: 'Assess risk for {{input.app}}', model: 'demo' },
    { name: 'Assess', attempts: 1 },
    ctx,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.output.severity, 'critical');
});

test('canonical http_request type performs the request', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ok = await executeStep(
      { type: 'http_request', method: 'GET', url: `http://127.0.0.1:${port}/` },
      { name: 'check', attempts: 1 },
      makeContext(),
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.output.status, 200);
  } finally {
    server.close();
  }
});

test('canonical conditional_branch type evaluates the expression', async () => {
  const ctx = makeContext();
  const ok = await executeStep(
    { type: 'conditional_branch', expression: "steps['Assess release risk'].severity == 'critical'" },
    { name: 'Requires approval?', attempts: 1 },
    ctx,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.output.result, true);
});
