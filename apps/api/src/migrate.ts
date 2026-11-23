import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from './database';

async function migrate(): Promise<void> {
  const migrations = join(__dirname, '../migrations');
  const files = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
  const database = openDatabase();
  try {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('era_pos_migrations'))");
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)');
      const applied = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
      const appliedNames = new Set(applied.rows.map(({ name }) => name));
      for (const name of files) {
        if (appliedNames.has(name)) continue;
        await client.query(await readFile(join(migrations, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        console.log('Applied', name);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await database.end();
  }
}

void migrate().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
