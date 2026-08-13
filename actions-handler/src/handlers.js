// Hasura Action handlers + webhook trigger.
//
// Security model (defense in depth, on top of Hasura action permissions):
//   1. Role validation  - only owner/editor may trigger; approval requires the
//                         role listed in the step's `approver_roles` (defaults
//                         to ["owner","editor"]). viewer can never trigger or
//                         approve.
//   2. Restricted steps - workflows containing db_write/notify steps may only
//                         be triggered by the owner (saving such workflows is
//                         gated by a Postgres trigger, see migrations).
//   3. Org consistency  - the workflow/run must belong to the session
//                         organization and the user must be a member.
//   4. Quota checking   - concurrent + monthly run limits are enforced inside
//                         a transaction that locks the organization row, so
//                         concurrent triggers serialize correctly.
//   5. Execution        - runs execute steps synchronously; approval gates
//                         pause the run, approveStep resumes it.
//
// Webhook trigger: an unauthenticated-to-GraphQL HTTP endpoint guarded by a
// shared secret token. It resolves an organization (slug or id) and a workflow
// (name or id), then runs the same create-and-execute path.

import { pool } from './db.js';
import { executeRun, hasRestrictedSteps, normalizeStepType } from './workflow.js';

const TRIGGER_ROLES = new Set(['owner', 'editor']);
const DEFAULT_APPROVER_ROLES = ['owner', 'editor'];
const ACTIVE_RUN_STATUSES = `('queued','running','paused','awaiting_approval')`;

class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function actionError(code, message) {
  return { error: { code, message } };
}

function outputFromRun(run) {
  const message = {
    completed: 'Workflow completed successfully',
    awaiting_approval: 'Workflow paused awaiting approval',
    failed: 'Workflow failed',
    cancelled: 'Workflow cancelled',
  }[run.status] || `Workflow ${run.status}`;
  return {
    run_id: run.id,
    status: run.status,
    current_step_index: run.current_step_index,
    message,
    error: run.error || null,
  };
}

async function checkMembership(client, orgId, userId) {
  const { rows } = await client.query(
    `SELECT 1 FROM organization_members
      WHERE organization_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
  return rows.length > 0;
}

// Hasura nests the action's arguments by name under `body.input`. Our actions
// declare a single argument named `input`, so the value lives at
// `body.input.input`; fall back to `body.input` for safety.
function actionInput(body) {
  const raw = body.input;
  if (raw && typeof raw === 'object' && raw.input && typeof raw.input === 'object') {
    return raw.input;
  }
  return raw || {};
}

// Shared create-and-execute path used by both the GraphQL action and the
// webhook trigger. The caller owns the transaction; the organization row is
// locked first so quota checks serialize correctly. `sessionRole` is only set
// for the GraphQL action path (webhook is token-guarded, no role).
async function createRunAndExecute(client, { orgId, workflowId, input, triggeredBy, triggerType, sessionRole }) {
  const { rows: orgRows } = await client.query(
    `SELECT id, quota_concurrent_runs, quota_monthly_runs
       FROM organizations WHERE id = $1 FOR UPDATE`,
    [orgId],
  );
  if (!orgRows[0]) throw new ActionError('not_found', 'Organization not found');
  const org = orgRows[0];

  const { rows: wfRows } = await client.query(
    `SELECT * FROM workflows WHERE id = $1 AND organization_id = $2`,
    [workflowId, orgId],
  );
  if (!wfRows[0]) {
    throw new ActionError('not_found', 'Workflow not found in this organization');
  }
  const workflow = wfRows[0];
  if (!workflow.is_active) {
    throw new ActionError('unprocessable', 'Workflow is inactive');
  }

  // Restricted steps (db_write / notify) may only be triggered by the owner.
  if (sessionRole && sessionRole !== 'owner' && hasRestrictedSteps(workflow.steps)) {
    throw new ActionError(
      'forbidden',
      'Only the organization owner may trigger workflows with db_write/notify steps',
    );
  }

  // Quota checks.
  const { rows: concurrentRows } = await client.query(
    `SELECT count(*)::int AS c FROM workflow_runs
      WHERE organization_id = $1 AND status IN ${ACTIVE_RUN_STATUSES}`,
    [orgId],
  );
  if (concurrentRows[0].c >= org.quota_concurrent_runs) {
    throw new ActionError(
      'quota_exceeded',
      `Concurrent workflow run quota exceeded (${org.quota_concurrent_runs})`,
    );
  }

  const { rows: monthlyRows } = await client.query(
    `SELECT count(*)::int AS c FROM workflow_runs
      WHERE organization_id = $1 AND created_at >= date_trunc('month', now())`,
    [orgId],
  );
  if (monthlyRows[0].c >= org.quota_monthly_runs) {
    throw new ActionError(
      'quota_exceeded',
      `Monthly workflow run quota exceeded (${org.quota_monthly_runs})`,
    );
  }

  // Create the run.
  const { rows: runRows } = await client.query(
    `INSERT INTO workflow_runs (organization_id, workflow_id, status, trigger_type, input, triggered_by)
     VALUES ($1, $2, 'running', $3, $4::jsonb, $5)
     RETURNING *`,
    [orgId, workflow.id, triggerType || 'manual', JSON.stringify(input || {}), triggeredBy || null],
  );
  const run = runRows[0];

  // Materialize step rows from the workflow definition.
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    await client.query(
      `INSERT INTO workflow_run_steps
         (organization_id, run_id, workflow_id, step_index, name, step_type, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orgId,
        run.id,
        workflow.id,
        i,
        step.name || step.type,
        normalizeStepType(step.type),
        Math.max(1, Number(step.max_attempts) || 1),
      ],
    );
  }

  const result = await executeRun(client, run.id);
  return result;
}

export async function handleTriggerWorkflowRun(body) {
  const session = body.session_variables || {};
  const role = session['x-hasura-role'];
  const orgId = session['x-hasura-organization-id'];
  const userId = session['x-hasura-user-id'];
  const { workflow_id: workflowId, input } = actionInput(body);

  if (!TRIGGER_ROLES.has(role)) {
    return actionError('forbidden', `Role "${role}" is not allowed to trigger workflow runs`);
  }
  if (!orgId || !userId) {
    return actionError('forbidden', 'Missing session organization or user id');
  }
  if (!workflowId) {
    return actionError('bad_request', 'workflow_id is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!(await checkMembership(client, orgId, userId))) {
      throw new ActionError('forbidden', 'User is not a member of this organization');
    }

    const result = await createRunAndExecute(client, {
      orgId,
      workflowId,
      input,
      triggeredBy: userId,
      triggerType: 'manual',
      sessionRole: role,
    });
    await client.query('COMMIT');
    return { data: outputFromRun(result) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ActionError) return actionError(err.code, err.message);
    console.error('[triggerWorkflowRun]', err);
    return actionError('internal', 'Internal error while triggering workflow run');
  } finally {
    client.release();
  }
}

// POST /webhook/trigger
// Body: { organization: "org-a" | <uuid>, workflow: "AI Release" | <uuid>, input: {...} }
// Header: x-webhook-token: <WEBHOOK_TOKEN>
export async function handleWebhookTrigger(req) {
  const token = String(process.env.WEBHOOK_TOKEN || '');
  const provided = String(req.headers?.['x-webhook-token'] || '');
  if (!token) {
    return { error: { code: 'webhook_disabled', message: 'WEBHOOK_TOKEN is not configured on the handler' } };
  }
  if (!provided || provided !== token) {
    return { error: { code: 'unauthorized', message: 'Invalid or missing webhook token' } };
  }

  const body = req.body || {};
  // Hasura cron triggers wrap the configured payload under `body.payload` and
  // add delivery metadata. Unwrap it so a cron trigger can drive the same
  // endpoint as a direct webhook call.
  const unwrapped = body.payload && typeof body.payload === 'object' && !body.organization
    ? body.payload
    : body;
  const organization = unwrapped.organization;
  const workflow = unwrapped.workflow;
  const input = unwrapped.input || {};

  if (!organization || !workflow) {
    return { error: { code: 'bad_request', message: 'organization and workflow are required' } };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve the organization by id or slug.
    const orgClause = /^[0-9a-fA-F-]{36}$/.test(organization)
      ? `WHERE id = $1`
      : `WHERE slug = $1`;
    const { rows: orgRows } = await client.query(
      `SELECT * FROM organizations ${orgClause} LIMIT 1`,
      [organization],
    );
    if (!orgRows[0]) throw new ActionError('not_found', 'Organization not found');
    const org = orgRows[0];

    // Resolve the workflow by id or name within the organization.
    const wfClause = /^[0-9a-fA-F-]{36}$/.test(workflow)
      ? `WHERE id = $2 AND organization_id = $1`
      : `WHERE name = $2 AND organization_id = $1`;
    const { rows: wfRows } = await client.query(
      `SELECT id FROM workflows ${wfClause} ORDER BY created_at LIMIT 1`,
      [org.id, workflow],
    );
    if (!wfRows[0]) {
      throw new ActionError('not_found', 'Workflow not found in this organization');
    }

    const result = await createRunAndExecute(client, {
      orgId: org.id,
      workflowId: wfRows[0].id,
      input,
      triggeredBy: null,
      triggerType: 'webhook',
    });
    await client.query('COMMIT');
    return { data: outputFromRun(result) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ActionError) return actionError(err.code, err.message);
    console.error('[webhook/trigger]', err);
    return actionError('internal', 'Internal error while triggering workflow run');
  } finally {
    client.release();
  }
}

export async function handleApproveStep(body) {
  const session = body.session_variables || {};
  const role = session['x-hasura-role'];
  const orgId = session['x-hasura-organization-id'];
  const userId = session['x-hasura-user-id'];
  const { run_id: runId, step_index: stepIndex, approved } = actionInput(body);

  if (!TRIGGER_ROLES.has(role)) {
    // Trigger roles double as approve roles (owner + editor); viewer is out.
    return actionError('forbidden', `Role "${role}" is not allowed to approve steps`);
  }
  if (!orgId || !userId) {
    return actionError('forbidden', 'Missing session organization or user id');
  }
  if (!runId || stepIndex == null || approved == null) {
    return actionError('bad_request', 'run_id, step_index and approved are required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the run row so concurrent approve/resume calls serialize.
    const { rows: runRows } = await client.query(
      `SELECT * FROM workflow_runs WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [runId, orgId],
    );
    if (!runRows[0]) throw new ActionError('not_found', 'Run not found in this organization');
    const run = runRows[0];

    if (!(await checkMembership(client, orgId, userId))) {
      throw new ActionError('forbidden', 'User is not a member of this organization');
    }

    const { rows: stepRows } = await client.query(
      `SELECT * FROM workflow_run_steps WHERE run_id = $1 AND step_index = $2`,
      [runId, stepIndex],
    );
    if (!stepRows[0]) {
      throw new ActionError('not_found', `Step at index ${stepIndex} not found`);
    }
    const step = stepRows[0];

    // Approver-role enforcement: read the step definition from the workflow
    // jsonb. `approver_roles` (default ["owner","editor"]) lists which roles may
    // approve this gate; the acting user's role must be in that set.
    const { rows: wfRows } = await client.query(
      `SELECT steps FROM workflows WHERE id = $1 AND organization_id = $2`,
      [run.workflow_id, orgId],
    );
    const wfSteps = Array.isArray(wfRows[0]?.steps) ? wfRows[0].steps : [];
    const def = wfSteps[stepIndex] || {};
    const approverRoles = Array.isArray(def.approver_roles) && def.approver_roles.length
      ? def.approver_roles
      : DEFAULT_APPROVER_ROLES;
    if (!approverRoles.includes(role)) {
      throw new ActionError(
        'forbidden',
        `Role "${role}" is not allowed to approve this step (requires ${approverRoles.join(' or ')})`,
      );
    }

    // Idempotent: if this gate was already handled, return the current state.
    if (run.status !== 'awaiting_approval' || step.status !== 'awaiting_approval') {
      await client.query('COMMIT');
      return { data: outputFromRun(run) };
    }

    await client.query(
      `UPDATE workflow_run_steps SET approved_by = $2, approved_at = now() WHERE id = $1`,
      [step.id, userId],
    );

    if (approved) {
      await client.query(
        `UPDATE workflow_run_steps
            SET status = 'completed', error = NULL, completed_at = now()
          WHERE id = $1`,
        [step.id],
      );
      await client.query(
        `UPDATE workflow_runs
            SET status = 'running', current_step_index = $2, error = NULL
          WHERE id = $1`,
        [run.id, stepIndex + 1],
      );
      const result = await executeRun(client, run.id);
      await client.query('COMMIT');
      return { data: outputFromRun(result) };
    }

    // Rejected -> cancel the run.
    await client.query(
      `UPDATE workflow_run_steps
          SET status = 'skipped', error = 'Approval rejected', completed_at = now()
        WHERE id = $1`,
      [step.id],
    );
    await client.query(
      `UPDATE workflow_runs
          SET status = 'cancelled', error = $2, completed_at = now()
        WHERE id = $1`,
      [run.id, `Approval rejected at step ${stepIndex} by user ${userId}`],
    );
    await client.query('COMMIT');
    const { rows: finalRows } = await client.query(
      `SELECT * FROM workflow_runs WHERE id = $1`,
      [run.id],
    );
    return { data: outputFromRun(finalRows[0]) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ActionError) return actionError(err.code, err.message);
    console.error('[approveStep]', err);
    return actionError('internal', 'Internal error while approving step');
  } finally {
    client.release();
  }
}
