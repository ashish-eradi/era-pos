import { randomUUID } from 'node:crypto';
import { openDatabase } from './database';
import { digest, secret, text, transaction } from './modules/onboarding/shared';

async function createOperator(): Promise<void> {
  const name = text(process.argv[2], 'operator name');
  const role = process.argv[3] ?? 'admin';
  if (role !== 'admin' && role !== 'support' && role !== 'finance') throw new Error('Select admin, support or finance');
  const database = openDatabase();
  try {
    const token = secret();
    const expiresAt = await transaction(database, async (client) => {
      const id = randomUUID();
      await client.query('INSERT INTO platform_operators VALUES ($1, $2, $3)', [id, name, role]);
      const { rows } = await client.query<{ expires_at: Date }>(`
        INSERT INTO platform_sessions VALUES ($1, $2, now() + interval '8 hours') RETURNING expires_at
      `, [digest(token), id]);
      return rows[0].expires_at;
    });
    console.log(`Operator token (expires ${expiresAt.toISOString()}): ${token}`);
  } finally {
    await database.end();
  }
}

void createOperator().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
