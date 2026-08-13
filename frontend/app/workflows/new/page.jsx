'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import NavBar from '../../../components/NavBar';
import StepEditor from '../../../components/StepEditor';
import { getSession, requireSession, sessionHeaders } from '../../../lib/session';
import { gqlRequest } from '../../../lib/hasura';
import { INSERT_WORKFLOW_MUTATION } from '../../../lib/queries';

export default function NewWorkflowPage() {
  const router = useRouter();
  const [session, setSession] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [steps, setSteps] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const s = requireSession();
    if (s) setSession(s);
  }, []);

  useEffect(() => {
    if (session && session.role === 'viewer') router.replace('/dashboard');
  }, [session, router]);

  async function save() {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const headers = sessionHeaders(session);
      const data = await gqlRequest(
        INSERT_WORKFLOW_MUTATION,
        { name: name.trim(), description: description.trim() || null, steps, is_active: isActive },
        headers,
      );
      router.replace(`/workflows/${data.insert_workflows_one.id}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  if (!session) return null;

  return (
    <div>
      <NavBar session={session} />
      <div className="container" style={{ maxWidth: 860 }}>
        <div className="spread">
          <h1 style={{ fontSize: 22 }}>New workflow</h1>
          <button className="btn primary" type="button" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save workflow'}
          </button>
        </div>
        {error && <div className="error-box">{error}</div>}

        <div className="card">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Deploy pipeline" />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional description"
            />
          </label>
          <label className="field">
            <span>Active</span>
            <select value={isActive ? 'true' : 'false'} onChange={(e) => setIsActive(e.target.value === 'true')}>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
        </div>

        <div className="card">
          <h2>Steps</h2>
          <StepEditor steps={steps} onChange={setSteps} isOwner={session.role === 'owner'} />
        </div>
      </div>
    </div>
  );
}
