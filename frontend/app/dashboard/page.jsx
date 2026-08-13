'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import NavBar from '../../components/NavBar';
import QuotaIndicator from '../../components/QuotaIndicator';
import { getSession, requireSession, sessionHeaders } from '../../lib/session';
import { gqlRequest } from '../../lib/hasura';
import { DASHBOARD_QUERY } from '../../lib/queries';

function monthStartIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export default function DashboardPage() {
  const [session, setSession] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const s = requireSession();
    if (!s) return;
    setSession(s);
    const headers = sessionHeaders(s);
    gqlRequest(
      DASHBOARD_QUERY,
      { orgId: s.organizationId, monthStart: monthStartIso() },
      headers,
    )
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (!session) return null;

  const org = data?.organizations_by_pk;
  const concurrent = data?.concurrent?.aggregate?.count ?? 0;
  const monthly = data?.monthly?.aggregate?.count ?? 0;
  const workflows = data?.workflows || [];
  const recentRuns = data?.recentRuns || [];

  return (
    <div>
      <NavBar session={session} />
      <div className="container">
        {error && <div className="error-box">{error}</div>}
        {!data && !error && <p className="muted">Loading…</p>}

        {org && (
          <>
            <div className="card">
              <div className="spread">
                <div>
                  <h2 style={{ margin: 0 }}>{org.name}</h2>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    {org.slug} · {org.members.length} member(s)
                  </p>
                </div>
                {session.role !== 'viewer' && (
                  <Link className="btn primary" href="/workflows/new">
                    + New workflow
                  </Link>
                )}
                {session.role === 'viewer' && (
                  <span className="badge step-status-pending">viewer: read-only</span>
                )}
              </div>
              <div style={{ marginTop: 12 }}>
                {org.members.map((m) => (
                  <span key={m.id} className="badge" style={{ marginRight: 6 }}>
                    {m.user?.name} ({m.role})
                  </span>
                ))}
              </div>
            </div>

            <div className="grid">
              <QuotaIndicator
                label="Concurrent runs"
                used={concurrent}
                quota={org.quota_concurrent_runs}
              />
              <QuotaIndicator
                label="Monthly runs"
                used={monthly}
                quota={org.quota_monthly_runs}
              />
            </div>

            <div className="card">
              <h2>Workflows</h2>
              {workflows.length === 0 ? (
                <p className="muted">No workflows yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Steps</th>
                      <th>Runs</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workflows.map((wf) => (
                      <tr key={wf.id}>
                        <td>
                          <Link href={`/workflows/${wf.id}`}>{wf.name}</Link>
                        </td>
                        <td>{Array.isArray(wf.steps) ? wf.steps.length : 0}</td>
                        <td>{wf.runs_aggregate?.aggregate?.count ?? 0}</td>
                        <td>
                          <span
                            className={`badge ${wf.is_active ? 'status-completed' : 'step-status-pending'}`}
                          >
                            {wf.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h2>Recent runs</h2>
              {recentRuns.length === 0 ? (
                <p className="muted">No runs yet — trigger one from a workflow.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Workflow</th>
                      <th>Status</th>
                      <th>Step</th>
                      <th>Created</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.map((run) => (
                      <tr key={run.id}>
                        <td>{run.workflow?.name}</td>
                        <td>
                          <span className={`badge status status-${run.status}`}>
                            {run.status}
                          </span>
                        </td>
                        <td>{run.current_step_index}</td>
                        <td className="muted">
                          {new Date(run.created_at).toLocaleString()}
                        </td>
                        <td>
                          <Link
                            className="btn sm"
                            href={`/workflows/${run.workflow?.id}`}
                          >
                            Open
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
