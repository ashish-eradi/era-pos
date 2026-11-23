import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { bearer } from '../onboarding/shared';

type Role = 'owner' | 'manager' | 'cashier' | 'accountant';

export async function branchActor(client: PoolClient, merchant: string, branch: string, roles: readonly Role[], authorization?: string) {
  const { rows } = await client.query<{ id: string; role: Role; assigned: boolean; exists: boolean }>(`
    SELECT m.id, m.role,
      EXISTS (SELECT 1 FROM branches WHERE merchant_id = $1 AND id = $3) AS exists,
      EXISTS (SELECT 1 FROM branch_assignments WHERE merchant_id = $1 AND branch_id = $3 AND membership_id = m.id) AS assigned
    FROM membership_sessions s JOIN memberships m
      ON (m.merchant_id,m.id) = (s.merchant_id,s.membership_id)
    WHERE s.merchant_id = $1 AND s.token_digest = $2 AND m.active
      AND s.revoked_at IS NULL AND s.expires_at > now()
    FOR SHARE OF m,s
  `, [merchant, bearer(authorization), branch]);
  const actor = rows[0];
  if (!actor) throw new UnauthorizedException();
  if (!roles.includes(actor.role)) throw new ForbiddenException();
  if (!actor.exists || (actor.role !== 'owner' && !actor.assigned)) throw new NotFoundException();
  return actor.id;
}

export async function deviceScope(client: PoolClient, device: string, authorization?: string) {
  const { rows } = await client.query<{ merchant_id: string; branch_id: string; id: string }>(`
    SELECT merchant_id,branch_id,id FROM registers
    WHERE device_id = $1 AND pairing_digest = $2 AND status = 'active' FOR UPDATE
  `, [device, bearer(authorization)]);
  if (!rows[0]) throw new UnauthorizedException();
  const { merchant_id: merchant, branch_id: branch, id: register } = rows[0];
  return [merchant, branch, register] as const;
}
