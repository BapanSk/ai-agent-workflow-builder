const KEY = 'mc_session';

export function getSession() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const session = raw ? JSON.parse(raw) : null;
    if (!session) return null;
    // The session object carries the JWT returned by /api/auth/login.
    return session.token ? session : null;
  } catch {
    return null;
  }
}

export function setSession(session) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable */
  }
}

export function clearSession() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

export function sessionHeaders(session) {
  if (!session) return {};
  return {
    authorization: `Bearer ${session.token}`,
  };
}

export function requireSession() {
  const session = getSession();
  if (!session) {
    window.location.href = '/login';
    return null;
  }
  return session;
}
