const BASE = 'http://localhost:4000';
const HASURA = 'http://localhost:8081/v1/graphql';
const TOKEN = 'dev-webhook-token';
const SECRET = 'dev-admin-secret';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: 'postgres://hasura:hasura@localhost:5432/app3', max: 3 });

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name} ${extra}`); }
}

async function webhook(body, token = TOKEN) {
  const res = await fetch(`${BASE}/webhook/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-webhook-token': token } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function gql(query, vars, headers = ADMIN) {
  const res = await fetch(HASURA, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables: vars }),
  });
  return res.json();
}

const ORG_A = '00000000-0000-0000-0000-000000000001';
const ORG_B = '00000000-0000-0000-0000-000000000002';
const ALICE = '00000000-0000-0000-0000-000000000011';
const BOB = '00000000-0000-0000-0000-000000000012';
const EVE = '00000000-0000-0000-0000-000000000015';
const AI_RELEASE = '00000000-0000-0000-0000-000000000044';
const DEPLOY_ALPHA = '00000000-0000-0000-0000-000000000041';
const DEPLOY_BETA = '00000000-0000-0000-0000-000000000043';
const FLAKY = '00000000-0000-0000-0000-000000000042';

function session(role, userId, orgId) {
  return {
    'x-hasura-admin-secret': SECRET,
    'x-hasura-role': role,
    'x-hasura-user-id': userId,
    'x-hasura-organization-id': orgId,
  };
}
const ADMIN = session('owner', ALICE, ORG_A);
const OWNER = ADMIN;
const EDITOR = session('editor', BOB, ORG_A);
const VIEWER = session('viewer', EVE, ORG_A);

async function q(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

console.log('== Webhook auth ==');
{
  let r = await webhook({ organization: 'org-a', workflow: 'AI Release' }, null);
  check('no token -> 401', r.status === 401, `got ${r.status}`);
  r = await webhook({ organization: 'org-a', workflow: 'AI Release' }, 'wrong');
  check('bad token -> 401', r.status === 401, `got ${r.status}`);
  r = await webhook({ organization: 'nope', workflow: 'AI Release' });
  check('unknown org -> 404', r.status === 404, `got ${r.status} ${JSON.stringify(r.json)}`);
  r = await webhook({ organization: 'org-a', workflow: 'Missing' });
  check('unknown workflow -> 404', r.status === 404, `got ${r.status}`);
  r = await webhook({ organization: 'org-a' });
  check('missing fields -> 400', r.status === 400, `got ${r.status}`);
}

console.log('== High-risk flow (approval gate) ==');
let RUN_ID;
{
  const r = await webhook({ organization: 'org-a', workflow: 'AI Release', input: { app: 'checkout', risk: 'critical' } });
  check('trigger -> awaiting_approval', r.status === 200 && r.json.status === 'awaiting_approval', JSON.stringify(r.json));
  RUN_ID = r.json.run_id;
  const steps = await q(`SELECT step_index, step_type, status FROM workflow_run_steps WHERE run_id=$1 ORDER BY step_index`, [RUN_ID]);
  check('6 steps materialized', steps.length === 6, `got ${steps.length}`);
  const statuses = steps.map((s) => `${s.step_type}:${s.status}`).join(',');
  check('llm_call/http_request/conditional_branch completed, approval awaiting',
    statuses === 'llm_call:completed,http_request:completed,conditional_branch:completed,approval_gate:awaiting_approval,db_write:pending,notify:pending', statuses);
  const llm = await q(`SELECT output FROM workflow_run_steps WHERE run_id=$1 AND step_index=0`, [RUN_ID]);
  check('llm_call simulated severity critical', llm[0].output.severity === 'critical', JSON.stringify(llm[0].output));
  const http = await q(`SELECT output FROM workflow_run_steps WHERE run_id=$1 AND step_index=1`, [RUN_ID]);
  check('http_request hit demo/status -> ok', http[0].output.body?.service === 'demo-api', JSON.stringify(http[0].output));
}

console.log('== Approve (owner) -> completes -> db_write + notify ==');
{
  const r = await gql(`mutation($i: ApproveStepInput!) { approveStep(input: $i) { run_id status current_step_index } }`,
    { i: { run_id: RUN_ID, step_index: 3, approved: true } });
  check('approve -> completed', r.data?.approveStep?.status === 'completed', JSON.stringify(r.errors));
  const ev = await q(`SELECT * FROM workflow_events WHERE run_id=$1`, [RUN_ID]);
  check('workflow_event row written', ev.length === 1 && ev[0].event_type === 'release.assessed', JSON.stringify(ev));
  check('event payload interpolated', ev[0].payload.app === 'checkout' && ev[0].payload.service === 'demo-api' && ev[0].payload.required_approval === 'true', JSON.stringify(ev[0].payload));
  const notif = await q(`SELECT * FROM notifications WHERE run_id=$1`, [RUN_ID]);
  check('notification row written', notif.length === 1 && /critical/.test(notif[0].body), JSON.stringify(notif));
}

console.log('== Editor can approve (owner+editor approver roles) ==');
{
  const r = await webhook({ organization: 'org-a', workflow: 'AI Release', input: { app: 'cart', risk: 'critical' } });
  check('owner-triggered critical -> awaiting_approval', r.json.status === 'awaiting_approval', JSON.stringify(r.json));
  const rid = r.json.run_id;
  const appr = await gql(`mutation($i: ApproveStepInput!) { approveStep(input: $i) { status } }`,
    { i: { run_id: rid, step_index: 3, approved: true } }, EDITOR);
  check('editor approve -> completed', appr.data?.approveStep?.status === 'completed', JSON.stringify(appr.errors));
}

console.log('== Viewer cannot trigger or approve (Hasura schema gate) ==');
{
  const t = await gql(`mutation($i: TriggerWorkflowRunInput!) { triggerWorkflowRun(input: $i) { run_id } }`,
    { i: { workflow_id: DEPLOY_ALPHA } }, VIEWER);
  check('viewer trigger unavailable', !!t.errors && /no mutations exist/.test(t.errors[0].message), JSON.stringify(t.errors));
  const a = await gql(`mutation($i: ApproveStepInput!) { approveStep(input: $i) { run_id } }`,
    { i: { run_id: RUN_ID, step_index: 3, approved: true } }, VIEWER);
  check('viewer approve unavailable', !!a.errors && /no mutations exist/.test(a.errors[0].message), JSON.stringify(a.errors));
}

console.log('== Editor cannot trigger workflows with restricted (db_write/notify) steps ==');
{
  const r = await gql(`mutation($i: TriggerWorkflowRunInput!) { triggerWorkflowRun(input: $i) { run_id status } }`,
    { i: { workflow_id: AI_RELEASE, input: { risk: 'low' } } }, EDITOR);
  check('editor trigger AI Release forbidden', !!r.errors && /owner may trigger workflows with db_write\/notify/.test(r.errors[0].message), JSON.stringify(r.errors));
}

console.log('== Editor can trigger + approve a non-restricted workflow ==');
{
  const r = await gql(`mutation($i: TriggerWorkflowRunInput!) { triggerWorkflowRun(input: $i) { run_id status } }`,
    { i: { workflow_id: DEPLOY_ALPHA } }, EDITOR);
  check('editor triggers Deploy Alpha -> awaiting_approval', r.data?.triggerWorkflowRun?.status === 'awaiting_approval', JSON.stringify(r.errors));
  const rid = r.data.triggerWorkflowRun.run_id;
  const appr = await gql(`mutation($i: ApproveStepInput!) { approveStep(input: $i) { status } }`,
    { i: { run_id: rid, step_index: 2, approved: true } }, EDITOR);
  check('editor approves Deploy Alpha -> completed', appr.data?.approveStep?.status === 'completed', JSON.stringify(appr.errors));
}

console.log('== Editor cannot save a workflow with db_write/notify steps (Postgres trigger) ==');
{
  const ins = await gql(`mutation($name: String!, $steps: jsonb!) { insert_workflows_one(object: { name: $name, steps: $steps }) { id } }`,
    { name: 'E2E editor restricted attempt', steps: [{ type: 'task', name: 'a' }, { type: 'db_write', name: 'w' }] }, EDITOR);
  const internalMsg = ins.errors?.[0]?.extensions?.internal?.error?.message || '';
  check('editor restricted save blocked', !!ins.errors && /Only the organization owner/.test(internalMsg), JSON.stringify(ins.errors));
  const ok = await gql(`mutation($name: String!, $steps: jsonb!) { insert_workflows_one(object: { name: $name, steps: $steps }) { id } }`,
    { name: 'E2E editor normal save', steps: [{ type: 'task', name: 'a' }] }, EDITOR);
  check('editor normal save allowed', !!ok.data?.insert_workflows_one?.id, JSON.stringify(ok.errors));
}

console.log('== Cross-org isolation ==');
{
  const r = await webhook({ organization: 'org-b', workflow: 'AI Release' });
  check('org-b has no AI Release -> 404', r.status === 404, `got ${r.status}`);
  const t = await gql(`mutation($i: TriggerWorkflowRunInput!) { triggerWorkflowRun(input: $i) { run_id } }`,
    { i: { workflow_id: DEPLOY_BETA } }, EDITOR);
  check('org-a editor cannot trigger org-b workflow', !!t.errors && /not found/.test(t.errors[0].message), JSON.stringify(t.errors));
  const r2 = await webhook({ organization: 'org-b', workflow: 'Deploy Beta', input: {} });
  check('org-b Deploy Beta triggers ok', r2.status === 200 && r2.json.status === 'completed', JSON.stringify(r2.json));
}

console.log('== Low-risk flow (conditional branch skips approval) ==');
{
  const r = await webhook({ organization: 'org-a', workflow: 'AI Release', input: { app: 'blog', risk: 'low' } });
  check('trigger -> completed directly', r.status === 200 && r.json.status === 'completed', JSON.stringify(r.json));
  const steps = await q(`SELECT step_type, status FROM workflow_run_steps WHERE run_id=$1 ORDER BY step_index`, [r.json.run_id]);
  const statuses = steps.map((s) => `${s.step_type}:${s.status}`).join(',');
  check('approval skipped, rest completed', statuses === 'llm_call:completed,http_request:completed,conditional_branch:completed,approval_gate:skipped,db_write:completed,notify:completed', statuses);
  const ev = await q(`SELECT payload FROM workflow_events WHERE run_id=$1`, [r.json.run_id]);
  check('low-risk payload has required_approval=false', ev[0].payload.required_approval === 'false' && ev[0].payload.severity === 'low', JSON.stringify(ev[0].payload));
}

console.log('== Regression: manual trigger (GraphQL action) + approve ==');
{
  const r = await gql(`mutation($i: TriggerWorkflowRunInput!) { triggerWorkflowRun(input: $i) { run_id status message } }`,
    { i: { workflow_id: DEPLOY_ALPHA } });
  check('manual trigger Deploy Alpha -> awaiting_approval', r.data?.triggerWorkflowRun?.status === 'awaiting_approval', JSON.stringify(r.errors));
  const id = r.data.triggerWorkflowRun.run_id;
  const r2 = await gql(`mutation($i: ApproveStepInput!) { approveStep(input: $i) { status } }`,
    { i: { run_id: id, step_index: 2, approved: true } });
  check('Deploy Alpha completed after approve', r2.data?.approveStep?.status === 'completed', JSON.stringify(r2.errors));
}

console.log('== Regression: reject cancels ==');
{
  const r = await gql(`mutation($i: TriggerWorkflowRunInput!) { triggerWorkflowRun(input: $i) { run_id status } }`,
    { i: { workflow_id: DEPLOY_ALPHA } });
  const id = r.data.triggerWorkflowRun.run_id;
  const r2 = await gql(`mutation($i: ApproveStepInput!) { approveStep(input: $i) { status error } }`,
    { i: { run_id: id, step_index: 2, approved: false } });
  check('reject -> cancelled', r2.data?.approveStep?.status === 'cancelled', JSON.stringify(r2.errors));
}

console.log('== Regression: retry (Flaky Build fail_first_n) ==');
{
  const r = await gql(`mutation($i: TriggerWorkflowRunInput!) { triggerWorkflowRun(input: $i) { run_id status } }`,
    { i: { workflow_id: FLAKY } });
  check('flaky build completes via retry', r.data?.triggerWorkflowRun?.status === 'completed', JSON.stringify(r.errors));
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
