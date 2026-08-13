import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgres://hasura:hasura@localhost:5432/app',
  max: 10,
  idleTimeoutMillis: 30_000,
});
