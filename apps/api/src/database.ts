import { Pool } from 'pg';

export function openDatabase(): Pool {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) throw new Error('Set DATABASE_URL before starting the backend');
  return new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
}
