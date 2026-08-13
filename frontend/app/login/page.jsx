'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setSession } from '../../lib/session';

const DEMO_ACCOUNTS = [
  { email: 'alice@org-a.test', label: 'Alice (owner, Org A)' },
  { email: 'bob@org-a.test', label: 'Bob (editor, Org A)' },
  { email: 'eve@org-a.test', label: 'Eve (viewer, Org A)' },
  { email: 'carol@org-b.test', label: 'Carol (owner, Org B)' },
  { email: 'dave@org-b.test', label: 'Dave (editor, Org B)' },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function doLogin(targetEmail) {
    const value = (targetEmail || email).trim();
    if (!value) {
      setError('Enter an email address');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Login failed');
        return;
      }
      setSession({ ...json.session, token: json.token });
      router.replace('/dashboard');
    } catch (err) {
      setError(`Login failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <div className="card">
        <h2>Workflow Console</h2>
        <p className="muted">
          Sign in with a demo account to launch multi-tenant workflows.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doLogin();
          }}
        >
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alice@org-a.test"
              autoComplete="email"
            />
          </label>
          <button className="btn primary" disabled={loading} type="submit">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {error && <div className="error-box">{error}</div>}
      </div>

      <div className="card">
        <h2>Demo accounts</h2>
        <div className="grid">
          {DEMO_ACCOUNTS.map((acc) => (
            <button
              key={acc.email}
              className="btn"
              disabled={loading}
              onClick={() => doLogin(acc.email)}
              type="button"
            >
              {acc.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
