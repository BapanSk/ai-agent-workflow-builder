import { NextResponse } from 'next/server';
import { signSessionToken } from '../../../../lib/jwt';

const ENDPOINT = process.env.HASURA_GRAPHQL_ENDPOINT || 'http://localhost:8081';
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET || 'dev-admin-secret';

const LOGIN_QUERY = `
  query Login($email: citext!) {
    users(where: { email: { _eq: $email } }, limit: 1) {
      id
      name
      email
      memberships {
        organization_id
        role
        organization {
          id
          name
          slug
        }
      }
    }
  }
`;

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* fall through */
  }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  }

  let res;
  try {
    res = await fetch(`${ENDPOINT}/v1/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hasura-admin-secret': ADMIN_SECRET,
      },
      body: JSON.stringify({ query: LOGIN_QUERY, variables: { email } }),
    });
  } catch (err) {
    return NextResponse.json({ error: `Backend unreachable: ${err.message}` }, { status: 502 });
  }

  const json = await res.json();
  const user = json?.data?.users?.[0];
  if (!user) {
    return NextResponse.json({ error: 'Unknown email' }, { status: 401 });
  }

  const memberships = user.memberships || [];
  if (memberships.length === 0) {
    return NextResponse.json({ error: 'User has no organization memberships' }, { status: 403 });
  }

  const active = memberships[0];
  const role = active.role;

  const session = {
    userId: user.id,
    name: user.name,
    email: user.email,
    role,
    organizationId: active.organization_id,
    organizationName: active.organization?.name,
    organizationSlug: active.organization?.slug,
    allowedOrganizations: memberships.map((m) => m.organization_id),
    organizations: memberships.map((m) => ({
      id: m.organization_id,
      name: m.organization?.name,
      slug: m.organization?.slug,
      role: m.role,
    })),
  };

  // Mint a signed JWT carrying the x-hasura-* claims. Hasura validates this
  // token (HASURA_GRAPHQL_JWT_SECRET) and derives the role/user/org from it,
  // so clients cannot impersonate another user or organization by setting
  // X-Hasura-* headers directly.
  const token = signSessionToken({
    userId: session.userId,
    role: session.role,
    organizationId: session.organizationId,
    allowedOrganizations: session.allowedOrganizations,
  });

  const response = NextResponse.json({ session, token });
  response.cookies.set('mc_session', JSON.stringify(session), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24,
  });
  response.cookies.set('mc_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24,
  });
  return response;
}
