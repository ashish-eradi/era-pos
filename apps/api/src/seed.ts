import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from './database';

async function seed(): Promise<void> {
  const fixture = await readFile(join(__dirname, '../../../fixtures/merchants.json'), 'utf8');
  const merchants = JSON.parse(fixture) as Array<{ id: string; name: string; countryCode: string }>;
  const database = openDatabase();
  try {
    const rows = merchants.map(({ id, name, countryCode }) => ({ id, name, country_code: countryCode }));
    await database.query(
      `INSERT INTO merchants (id, name, country_code)
       SELECT id, name, country_code
       FROM jsonb_to_recordset($1::jsonb) AS seed(id text, name text, country_code text)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(rows)],
    );
    console.log('Seeded synthetic merchants');
  } finally {
    await database.end();
  }
}

void seed().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
