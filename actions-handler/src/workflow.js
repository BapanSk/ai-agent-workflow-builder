// Workflow execution engine.
//
// A run is executed synchronously within a single DB transaction. executeRun
// resumes from `workflow_runs.current_step_index` and continues until one of:
//   - an approval step is reached   -> run pauses as `awaiting_approval`
//   - a step exhausts its retries   -> run fails
//   - all steps completed           -> run completes
//
// This lets both triggerWorkflowRun and approveStep drive the same engine:
// the latter only flips the gate and calls executeRun again.
//
// Step types (assignment vocabulary):
//   task / sleep           deterministic simulated work (existing)
//   approval_gate          pauses the run for an owner/editor decision
//   conditional_branch     evaluates an expression against the run context
//   llm_call               calls an LLM chat-completions endpoint (or simulated)
//   http_request           performs an outbound HTTP request
//   db_write               inserts a row into an allow-listed table
//   notify                 inserts a row into `notifications`
//
// Legacy names (llm / http / condition / approval) are accepted as aliases.
//
// Any step may carry a `when` expression: if it evaluates falsy, the step is
// marked `skipped` and execution continues (conditional branch). Steps may use
// `{{ ... }}` templates referencing the run context (input, prior outputs).

import { pool } from './db.js';
import { evaluate, renderTemplate, renderValue } from './expr.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_TABLES = new Set(['workflow_events', 'notifications']);

// Assignment step-type vocabulary. Legacy engine names are aliases so existing
// workflow definitions and materialized rows keep working.
const STEP_TYPE_ALIASES = {
  llm: 'llm_call',
  http: 'http_request',
  condition: 'conditional_branch',
  approval: 'approval_gate',
};

// Restricted step types: workflows containing these may only be created/edited
// and triggered by the owner role (db_write / notify write data or send
// notifications; webhook triggering is token-guarded by the owner).
const RESTRICTED_STEP_TYPES = new Set(['db_write', 'notify']);

export function normalizeStepType(type) {
  return STEP_TYPE_ALIASES[type] || type;
}

export function hasRestrictedSteps(steps) {
  return Array.isArray(steps)
    ? steps.some((s) => RESTRICTED_STEP_TYPES.has(normalizeStepType(s?.type)))
    : false;
}

function envOf() {
  return {
    HANDLER_BASE_URL: process.env.HANDLER_BASE_URL || 'http://localhost:4000',
    USER_LLM_BASE_URL: process.env.USER_LLM_BASE_URL || '',
    USER_LLM_MODEL: process.env.USER_LLM_MODEL || '',
  };
}

// Build the expression/template context for a run from its input and the
// outputs produced so far.
function buildContext(run, outputsByIndex, outputsByName) {
  const outputList = [];
  const names = {};
  for (const [k, v] of Object.entries(outputsByIndex)) {
    outputList[Number(k)] = v;
  }
  for (const [name, v] of Object.entries(outputsByName)) {
    names[name] = v;
  }
  const ctx = {
    input: run.input || {},
    outputs: outputList,
    steps: names,
    env: envOf(),
  };
  ctx.prev = outputList[outputList.length - 1];
  return ctx;
}

/**
 * Execute a single step definition against a step row and the run context.
 * Returns `{ ok, output, error }`.
 */
export async function executeStep(stepDef, stepRow, ctx = {}) {
  switch (normalizeStepType(stepDef.type)) {
    case 'sleep': {
      const seconds = Number(stepDef.duration_seconds) || 0;
      if (seconds > 0) await sleep(Math.min(seconds, 60) * 1000);
      return { ok: true, output: { waited_seconds: seconds } };
    }
    case 'task': {
      const failFirstN = Number(stepDef.fail_first_n) || 0;
      if (stepRow.attempts <= failFirstN) {
        return {
          ok: false,
          error: `Simulated failure on attempt ${stepRow.attempts}`,
        };
      }
      if (stepDef.force_fail) {
        return {
          ok: false,
          error: stepDef.fail_message || 'Step failed (forced for testing)',
        };
      }
      const failRate = Number(stepDef.fail_rate) || 0;
      if (failRate > 0 && Math.random() < failRate) {
        return { ok: false, error: 'Step failed (fail_rate simulation)' };
      }
      return {
        ok: true,
        output: {
          task: stepDef.name || stepRow.name,
          attempt: stepRow.attempts,
          completed_at: new Date().toISOString(),
        },
      };
    }
    case 'conditional_branch': {
      const expression = stepDef.expression || 'false';
      let result = false;
      let error = null;
      try {
        result = Boolean(evaluate(expression, ctx));
      } catch (err) {
        error = `Invalid condition expression: ${err.message}`;
      }
      if (error) return { ok: false, error };
      return { ok: true, output: { result, expression } };
    }
    case 'llm_call': {
      const prompt = renderTemplate(stepDef.prompt || '', ctx);
      const model = stepDef.model || process.env.USER_LLM_MODEL || 'demo-llm';
      const baseUrl = process.env.USER_LLM_BASE_URL || '';
      const apiKey = process.env.USER_LLM_API_KEY || '';

      if (!baseUrl || !apiKey) {
        // Deterministic simulation so the demo works without an LLM key.
        const severity =
          /critical|high|major/i.test(String(ctx.input.risk || '')) || /critical|high/i.test(prompt)
            ? 'critical'
            : 'low';
        return {
          ok: true,
          output: {
            simulated: true,
            model,
            severity,
            summary: `Simulated assessment for "${prompt || 'unlabeled prompt'}": ${severity} risk`,
          },
        };
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: 'You are a release-risk classifier. Answer with one word: critical or low.' },
              { role: 'user', content: prompt },
            ],
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { ok: false, error: `LLM request failed (${res.status}): ${text.slice(0, 200)}` };
        }
        const json = await res.json();
        const content = String(json?.choices?.[0]?.message?.content || '').trim().toLowerCase();
        return {
          ok: true,
          output: {
            simulated: false,
            model,
            severity: content.includes('critical') ? 'critical' : 'low',
            content,
          },
        };
      } catch (err) {
        return { ok: false, error: `LLM request error: ${err.message}` };
      }
    }
    case 'http_request': {
      const method = String(stepDef.method || 'GET').toUpperCase();
      if (!HTTP_METHODS.has(method)) {
        return { ok: false, error: `Unsupported http method: ${method}` };
      }
      const url = renderTemplate(stepDef.url || '', ctx);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { ok: false, error: `Invalid http url: ${url}` };
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { ok: false, error: `http step only supports http(s), got ${parsed.protocol}` };
      }
      const headers = renderValue(stepDef.headers || {}, ctx);
      const timeoutMs = Math.min(Number(stepDef.timeout_seconds || 10), 30) * 1000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          signal: controller.signal,
          ...(method === 'GET' || method === 'DELETE'
            ? {}
            : { body: JSON.stringify(renderValue(stepDef.body || {}, ctx)) }),
        });
        const text = await res.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        if (!res.ok) {
          return {
            ok: false,
            error: `HTTP ${res.status} ${res.statusText} for ${method} ${url}`,
          };
        }
        return {
          ok: true,
          output: {
            status: res.status,
            body,
            method,
            url,
          },
        };
      } catch (err) {
        return { ok: false, error: `HTTP request failed: ${err.message}` };
      } finally {
        clearTimeout(timer);
      }
    }
    case 'db_write': {
      const table = stepDef.table || 'workflow_events';
      if (!WRITE_TABLES.has(table)) {
        return { ok: false, error: `db_write: table "${table}" is not allow-listed` };
      }
      const payload = renderValue(stepDef.data || {}, ctx);
      const eventType = String(renderTemplate(stepDef.event_type || 'event', ctx) || 'event');
      const { rows } = await ctx.client.query(
        `INSERT INTO ${table} (organization_id, run_id, workflow_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id`,
        [
          ctx.run.organization_id,
          ctx.run.id,
          ctx.run.workflow_id,
          eventType,
          JSON.stringify(payload),
        ],
      );
      return {
        ok: true,
        output: { table, event_type: eventType, id: rows[0].id },
      };
    }
    case 'notify': {
      const title = renderTemplate(stepDef.title || '', ctx);
      const body = renderTemplate(stepDef.body || '', ctx);
      const { rows } = await ctx.client.query(
        `INSERT INTO notifications (organization_id, run_id, workflow_id, title, body)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [ctx.run.organization_id, ctx.run.id, ctx.run.workflow_id, title, body],
      );
      return {
        ok: true,
        output: { id: rows[0].id, title },
      };
    }
    default:
      return { ok: false, error: `Unsupported step type: ${stepDef.type}` };
  }
}

export async function loadRun(client, runId) {
  const { rows } = await client.query(
    `SELECT r.*, w.steps
       FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflow_id AND w.organization_id = r.organization_id
      WHERE r.id = $1`,
    [runId],
  );
  return rows[0] || null;
}

// Load completed step outputs so a resumed run (after approval) has the full
// context available to later condition/template steps.
async function loadOutputs(client, runId) {
  const { rows } = await client.query(
    `SELECT step_index, name, output FROM workflow_run_steps
      WHERE run_id = $1 AND status = 'completed' AND output IS NOT NULL
      ORDER BY step_index`,
    [runId],
  );
  const byIndex = {};
  const byName = {};
  for (const row of rows) {
    byIndex[row.step_index] = row.output;
    byName[row.name] = row.output;
  }
  return { byIndex, byName };
}

function stepHasWhen(stepDef) {
  return stepDef.when !== undefined && stepDef.when !== null && String(stepDef.when).trim() !== '';
}

/**
 * Resume execution of a run from its current step index. Must be called inside
 * the transaction that owns the run (the run row is assumed locked).
 */
export async function executeRun(client, runId) {
  const run = await loadRun(client, runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (TERMINAL.has(run.status)) return run;

  const steps = Array.isArray(run.steps) ? run.steps : [];
  let index = run.current_step_index;

  const { byIndex, byName } = await loadOutputs(client, runId);

  while (index < steps.length) {
    const stepDef = steps[index];
    const { rows } = await client.query(
      `SELECT * FROM workflow_run_steps WHERE run_id = $1 AND step_index = $2`,
      [runId, index],
    );
    const stepRow = rows[0];

    // Conditional branch: skip steps whose `when` gate is not satisfied.
    if (stepHasWhen(stepDef)) {
      let gate = false;
      try {
        gate = Boolean(evaluate(stepDef.when, buildContext(run, byIndex, byName)));
      } catch {
        gate = false;
      }
      if (!gate) {
        await client.query(
          `UPDATE workflow_run_steps
              SET status = 'skipped', error = 'Conditional gate not met', completed_at = now()
            WHERE id = $1`,
          [stepRow.id],
        );
        index += 1;
        continue;
      }
    }

    if (normalizeStepType(stepDef.type) === 'approval_gate') {
      await client.query(
        `UPDATE workflow_run_steps SET status = 'awaiting_approval' WHERE id = $1`,
        [stepRow.id],
      );
      await client.query(
        `UPDATE workflow_runs SET status = 'awaiting_approval', current_step_index = $2, error = NULL WHERE id = $1`,
        [runId, index],
      );
      return loadRun(client, runId);
    }

    // Mark running.
    await client.query(
      `UPDATE workflow_run_steps
          SET status = 'running', started_at = COALESCE(started_at, now()), error = NULL
        WHERE id = $1`,
      [stepRow.id],
    );
    await client.query(
      `UPDATE workflow_runs SET status = 'running', current_step_index = $2, error = NULL WHERE id = $1`,
      [runId, index],
    );

    const maxAttempts = Math.max(1, Number(stepDef.max_attempts) || 1);
    let result = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await client.query(
        `UPDATE workflow_run_steps SET attempts = $2 WHERE id = $1`,
        [stepRow.id, attempt],
      );
      const fresh = (
        await client.query(`SELECT * FROM workflow_run_steps WHERE id = $1`, [
          stepRow.id,
        ])
      ).rows[0];
      const ctx = buildContext(run, byIndex, byName);
      result = await executeStep(stepDef, fresh, { ...ctx, client, run });

      if (result.ok) break;

      await client.query(
        `UPDATE workflow_run_steps SET error = $2 WHERE id = $1`,
        [stepRow.id, result.error],
      );
      if (attempt < maxAttempts) {
        const delayMs = (Number(stepDef.retry_delay_seconds) || 0) * 1000;
        if (delayMs > 0) await sleep(Math.min(delayMs, 10_000));
      }
    }

    if (result.ok) {
      await client.query(
        `UPDATE workflow_run_steps
            SET status = 'completed', output = $2::jsonb, error = NULL, completed_at = now()
          WHERE id = $1`,
        [stepRow.id, JSON.stringify(result.output)],
      );
      byIndex[index] = result.output;
      byName[stepDef.name || stepRow.name] = result.output;
    } else {
      await client.query(
        `UPDATE workflow_run_steps
            SET status = 'failed', completed_at = now()
          WHERE id = $1`,
        [stepRow.id],
      );
      await client.query(
        `UPDATE workflow_runs
            SET status = 'failed', error = $2, completed_at = now()
          WHERE id = $1`,
        [runId, result.error],
      );
      return loadRun(client, runId);
    }

    index += 1;
  }

  await client.query(
    `UPDATE workflow_runs
        SET status = 'completed', current_step_index = $2, completed_at = now(), error = NULL
      WHERE id = $1`,
    [runId, steps.length],
  );
  return loadRun(client, runId);
}

export { pool };
