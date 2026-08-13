'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import NavBar from '../../../components/NavBar';
import StepEditor from '../../../components/StepEditor';
import RunPanel from '../../../components/RunPanel';
import { getSession, requireSession, sessionHeaders } from '../../../lib/session';
import { gqlRequest } from '../../../lib/hasura';
import {
  WORKFLOW_DETAIL_QUERY,
  UPDATE_WORKFLOW_MUTATION,
  DELETE_WORKFLOW_MUTATION,
  TRIGGER_RUN_MUTATION,
} from '../../../lib/queries';

export default function WorkflowDetailPage() {
  const params = useParams();
  const id = params.id;

  const [session, setSession] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [steps, setSteps] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [liveRunId, setLiveRunId] = useState(null);
  const [headers, setHeaders] = useState({});

  useEffect(() => {
    const s = requireSession();
    if (!s) return;
    setSession(s);
    setHeaders(sessionHeaders(s));
  }, []);

  useEffect(() => {
    if (!id || !session?.token) return;
    gqlRequest(WORKFLOW_DETAIL_QUERY, { id }, sessionHeaders(session))
      .then((d) => {
        const wf = d.workflows_by_pk;
        if (!wf) {
          setError('Workflow not found');
          return;
        }
        setWorkflow(wf);
        setName(wf.name);
        setDescription(wf.description || '');
        setIsActive(wf.is_active);
        setSteps(Array.isArray(wf.steps) ? wf.steps : []);
      })
      .catch((err) => setError(err.message));
  }, [id, headers]);

  const canEdit = session?.role === 'owner' || session?.role === 'editor';
  const canTrigger = canEdit;
  const canDelete = session?.role === 'owner';
  const canApprove = canEdit;

  async function save() {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const data = await gqlRequest(
        UPDATE_WORKFLOW_MUTATION,
        {
          id,
          name: name.trim(),
          description: description.trim() || null,
          steps,
          is_active: isActive,
        },
        headers,
      );
      setNotice(`Saved (${data.update_workflows_by_pk.id.slice(0, 8)}).`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this workflow and its runs?')) return;
    setError('');
    try {
      await gqlRequest(DELETE_WORKFLOW_MUTATION, { id }, headers);
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err.message);
    }
  }

  async function run() {
    setRunning(true);
    setError('');
    setNotice('');
    try {
      const data = await gqlRequest(
        TRIGGER_RUN_MUTATION,
        { input: { workflow_id: id } },
        headers,
      );
      const out = data.triggerWorkflowRun;
      setLiveRunId(out.run_id);
      setNotice(`${out.message} (${out.status}).`);
      if (out.status === 'failed' && out.error) setError(out.error);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  if (!session) return null;

  const runs = workflow?.runs || [];

  return (
    <div>
      <NavBar session={session} />
      <div className="container" style={{ maxWidth: 980 }}>
        <div className="spread">
          <h1 style={{ fontSize: 22 }}>{workflow ? workflow.name : '…'}</h1>
          <div className="row">
            {canEdit && (
              <>
                <button className="btn primary" type="button" disabled={saving} onClick={save}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {canDelete && (
                  <button className="btn danger" type="button" onClick={remove}>
                    Delete
                  </button>
                )}
              </>
            )}
            {canTrigger && (
              <button className="btn success" type="button" disabled={running || !workflow?.is_active} onClick={run}>
                {running ? 'Running…' : 'Run workflow'}
              </button>
            )}
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}
        {notice && <p className="muted">{notice}</p>}
        {workflow && !workflow.is_active && (
          <p className="muted">This workflow is inactive and cannot be run.</p>
        )}

        {workflow && (
          <div className="card">
            <h2>Webhook trigger</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              POST <code>/webhook/trigger</code> with the <code>x-webhook-token</code> header to
              run this workflow from any external system:
            </p>
            <pre className="code-block">{`curl -X POST ${window.location.origin}/webhook/trigger \\
  -H 'content-type: application/json' \\
  -H 'x-webhook-token: <WEBHOOK_TOKEN>' \\
  -d '{"organization":"${session.organizationSlug}","workflow":"${workflow.name}","input":{"app":"checkout","risk":"critical"}}'`}</pre>
          </div>
        )}

        {canEdit && workflow && (
          <div className="card">
            <h2>Definition</h2>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </label>
            <label className="field">
              <span>Active</span>
              <select
                value={isActive ? 'true' : 'false'}
                onChange={(e) => setIsActive(e.target.value === 'true')}
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </label>
            <StepEditor steps={steps} onChange={setSteps} isOwner={session.role === 'owner'} />
          </div>
        )}

        {!canEdit && workflow && (
          <div className="card">
            <h2>Steps (read-only)</h2>
            {steps.map((step, i) => (
              <div key={`${i}-${step.type}`} style={{ padding: '4px 0' }}>
                <strong>{i + 1}.</strong> {step.name || step.type}{' '}
                <span className="muted">({step.type})</span>
              </div>
            ))}
          </div>
        )}

        <RunPanel runId={liveRunId} canApprove={canApprove} headers={headers} />

        <div className="card">
          <h2>Run history</h2>
          {runs.length === 0 ? (
            <p className="muted">No runs yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Step</th>
                  <th>Triggered by</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.id.slice(0, 8)}</td>
                    <td>
                      <span className={`badge status status-${run.status}`}>{run.status}</span>
                    </td>
                    <td>{run.current_step_index}</td>
                    <td>{run.triggerer?.name || '—'}</td>
                    <td className="muted">{new Date(run.created_at).toLocaleString()}</td>
                    <td>
                      <button
                        className="btn sm"
                        type="button"
                        onClick={() => setLiveRunId(run.id)}
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
