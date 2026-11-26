import { scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { CashierSession } from '../../apps/counter/src/main/cashier-access';

vi.mock('electron', () => ({
  safeStorage: { decryptString: (data: Buffer) => data.toString() },
}));

it('renews an active session on input and locks after five idle minutes', () => {
  vi.useFakeTimers();
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE register_settings (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare('INSERT INTO register_settings VALUES (?,?)');
    insert.run('pairing', JSON.stringify({ registerId: 'counter' }));
    const salt = 'a'.repeat(32);
    const verifier = scryptSync('123456',salt,32).toString('hex');
    const staff = [{ id:'alice', name:'Alice', salt, verifier }];
    insert.run('staff:counter', Buffer.from(JSON.stringify(staff)).toString('base64'));
    const changed = vi.fn();
    const session = new CashierSession(db, changed);
    session.unlock('alice','123456');
    vi.advanceTimersByTime(299999);
    session.activity();
    vi.advanceTimersByTime(299999);
    expect(session.require().id).toBe('alice');
    vi.advanceTimersByTime(1);
    expect(() => session.require()).toThrow(/Unlock/);
    expect(changed.mock.lastCall?.[0].active).toBeUndefined();
    for (let attempt=0; attempt<5; attempt++)
      expect(() => session.unlock('alice','111111')).toThrow(/Incorrect/);
    const restarted = new CashierSession(db, changed);
    expect(() => restarted.unlock('alice','123456')).toThrow(/Too many/);
    vi.advanceTimersByTime(60000);
    expect(restarted.unlock('alice','123456').active?.id).toBe('alice');
  } finally {
    db.close();
    vi.useRealTimers();
  }
});
