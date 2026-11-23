import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { bearer } from './shared';

type Role = 'admin' | 'support' | 'finance';

export async function platformActor(database: Pool | PoolClient, roles: readonly Role[], authorization?: string) {
  const { rows } = await database.query<{ id: string; role: Role }>(`
    SELECT o.id, o.role FROM platform_sessions s JOIN platform_operators o ON o.id = s.operator_id
    WHERE s.digest = $1 AND s.expires_at > now()
  `, [bearer(authorization)]);
  const actor = rows[0];
  if (!actor) throw new UnauthorizedException();
  if (!roles.includes(actor.role)) throw new ForbiddenException();
  return actor;
}
