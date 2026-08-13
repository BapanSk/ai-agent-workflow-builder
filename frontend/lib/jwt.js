// Server-only JWT (HS256) helpers used by the login route to mint the session
// token that Hasura validates via HASURA_GRAPHQL_JWT_SECRET. Nhost-style: the
// token carries the x-hasura-* claims, so the GraphQL engine derives the role,
// user and organization from a cryptographically-signed token instead of
// trusting client-supplied X-Hasura-* headers.
import { createHmac, timingSafeEqual } from 'node:crypto';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlJson(obj) {
  return base64url(JSON.stringify(obj));
}

export function getJwtSecret() {
  return String(process.env.AUTH_JWT_SECRET || process.env.HASURA_GRAPHQL_JWT_SECRET || 'dev-jwt-secret');
}

export function signSessionToken(payload, { secret, ttlSeconds = 60 * 60 * 24 } = {}) {
  const key = secret || getJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  const body = {
    sub: payload.userId,
    iat: now,
    exp: now + ttlSeconds,
    'https://hasura.io/jwt/claims': {
      'x-hasura-default-role': payload.role,
      'x-hasura-allowed-roles': payload.allowedRoles || [payload.role, 'user'],
      'x-hasura-user-id': payload.userId,
      'x-hasura-organization-id': payload.organizationId,
      // Hasura expects session variables as strings; arrays are passed in the
      // same Postgres array-literal form the engine uses for `_in` filters.
      'x-hasura-allowed-organizations': `{${(payload.allowedOrganizations || []).join(',')}}`,
    },
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(body)}`;
  const signature = createHmac('sha256', key).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export function verifySessionToken(token, { secret } = {}) {
  const key = secret || getJwtSecret();
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const claims = payload['https://hasura.io/jwt/claims'] || {};
    return {
      userId: claims['x-hasura-user-id'] || payload.sub,
      role: claims['x-hasura-default-role'],
      organizationId: claims['x-hasura-organization-id'],
      allowedOrganizations: claims['x-hasura-allowed-organizations'] || [],
      exp: payload.exp,
      iat: payload.iat,
    };
  } catch {
    return null;
  }
}
