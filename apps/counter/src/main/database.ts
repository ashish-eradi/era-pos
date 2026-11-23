import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openCounterDatabase(path: string, migrations: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL;');
    database.exec('BEGIN IMMEDIATE');
    const row = database.prepare('PRAGMA user_version').get();
    let version = Number(row?.user_version);
    const files = readdirSync(migrations).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
    for (const file of files) {
      const next = Number(file.slice(0, 3));
      if (next <= version) continue;
      if (next !== version + 1) throw new Error(`Missing SQLite migration before ${file}`);
      database.exec(readFileSync(join(migrations, file), 'utf8'));
      database.exec(`PRAGMA user_version = ${next}`);
      version = next;
    }
    database.exec('COMMIT');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
