'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearSession } from '../lib/session';

export default function NavBar({ session }) {
  const router = useRouter();
  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    clearSession();
    router.replace('/login');
  }

  return (
    <nav className="navbar">
      <div className="row">
        <Link className="brand" href="/dashboard">
          Workflow Console
        </Link>
        <span className="muted">
          {session.organizationName} · {session.name}
        </span>
        <span className={`badge ${session.role}`}>{session.role}</span>
      </div>
      <div className="row">
        {session.role !== 'viewer' && (
          <Link className="btn sm" href="/workflows/new">
            + New workflow
          </Link>
        )}
        <button className="btn sm" type="button" onClick={logout}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
