'use client';

import { useEffect, useRef, useState } from 'react';
import { subscribeToRun, gqlRequest } from '../lib/hasura';
import { RUN_LIVE_SUBSCRIPTION, APPROVE_STEP_MUTATION } from '../lib/queries';

const STEP_LABELS = {
  task: 'Task',
  sleep: 'Sleep',
  approval_gate: 'Approval',
  conditional_branch: 'Conditional branch',
  llm_call: 'LLM',
  http_request: 'HTTP',
  db_write: 'DB write',
  notify: 'Notify',
  approval: 'Approval',
  condition: 'Condition',
  llm: 'LLM',
  http: 'HTTP',
};

function StepRow({ step, canApprove, onApprove, busy }) {
  const statusClass = `step-status-${step.status}`;
  return (
    <tr>
      <td>
        <strong>{step.step_index + 1}.</strong>{' '}
        {step.name || STEP_LABELS[step.step_type] || step.step_type}
        <div className="muted">
          {STEP_LABELS[step.step_type] || step.step_type}
          {step.attempts > 0 && ` · attempt ${step.attempts}/${step.max_attempts}`}
        </div>
      </td>
      <td>
        <span className={`badge ${statusClass}`}>{step.status}</span>
      </td>
      <td className="muted">
        {step.error || ''}
        {step.output ? JSON.stringify(step.output) : ''}
      </td>
      <td>
        {canApprove && step.status === 'awaiting_approval' && (
          <div className="row">
            <button
              className="btn sm success"
              type="button"
              disabled={busy}
              onClick={() => onApprove(true)}
            >
              Approve
            </button>
            <button
              className="btn sm danger"
              type="button"
              disabled={busy}
              onClick={() => onApprove(false)}
            >
              Reject
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

export default function RunPanel({ runId, canApprove, headers }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const subRef = useRef(null);

  useEffect(() => {
    if (!runId) return undefined;
    setData(null);
    setError('');
    const unsubscribe = subscribeToRun(
      RUN_LIVE_SUBSCRIPTION,
      { runId },
      headers,
      {
        onData: (result) => setData(result),
        onError: (err) => setError(err?.message || String(err)),
      },
    );
    subRef.current = unsubscribe;
    return () => unsubscribe();
  }, [runId, headers]);

  useEffect(() => () => subRef.current?.(), []);

  async function approve(approved) {
    setBusy(true);
    setError('');
    try {
      const steps = data?.workflow_run_steps || [];
      const approvalStep = steps.find((s) => s.status === 'awaiting_approval');
      const stepIndex = approvalStep ? approvalStep.step_index : 0;
      await gqlRequest(
        APPROVE_STEP_MUTATION,
        { input: { run_id: runId, step_index: stepIndex, approved } },
        headers,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!runId) return null;
  if (!data) {
    return (
      <div className="card">
        <h2>Live run</h2>
        <p className="muted">{error || 'Waiting for run data…'}</p>
      </div>
    );
  }

  const steps = data.workflow_run_steps || [];
  const run = steps[0]?.run || { status: 'unknown', current_step_index: 0 };

  return (
    <div className="card">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Run {runId.slice(0, 8)}</h2>
        <span className={`badge status status-${run.status}`}>{run.status}</span>
      </div>
      {error && <div className="error-box">{error}</div>}
      {steps.length === 0 ? (
        <p className="muted">No steps materialized yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Status</th>
              <th>Detail</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                canApprove={canApprove}
                busy={busy}
                onApprove={approve}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
