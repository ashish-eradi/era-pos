import { randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { allowProvisioning } from '../merchant/subscription-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { digest, email, owner, record, secret, text, transaction, uuid } from './shared';

function codeDigest(input: unknown): string {
  const code = text(input, 'code', 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new BadRequestException('Invalid code');
  return digest(code);
}

@Controller('v1')
export class OnboardingController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Post('merchants/:merchantId/branches/:branchId/staff-invitations')
  staff(@Param('merchantId') merchantId: string, @Param('branchId') branchId: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const actor = await owner(client, merchantId, authorization);
      const data = record(input);
      const contact = email(data.email);
      const role = data.role;
      if (role !== 'manager' && role !== 'cashier' && role !== 'accountant') throw new BadRequestException('Select a branch role');
      const branch = await client.query('SELECT 1 FROM branches WHERE merchant_id = $1 AND id = $2', [merchantId, branchId]);
      if (!branch.rowCount) throw new NotFoundException();
      const code = secret();
      const issued = await client.query<{ expires_at: Date }>(`
        INSERT INTO invitations (digest, merchant_id, branch_id, email, role, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours') RETURNING expires_at
      `, [digest(code), merchantId, branchId, contact, role]);
      await client.query(`
        INSERT INTO onboarding_audit (merchant_id, branch_id, membership_id, action, details)
        VALUES ($1, $2, $3, 'staff.invited', jsonb_build_object('role', $4::text))
      `, [merchantId, branchId, actor, role]);
      return { code, expiresAt: issued.rows[0].expires_at };
    });
  }

  @Post('invitations/accept')
  accept(@Body() input: unknown) {
    const hash = codeDigest(record(input).code);
    return transaction(this.database, async (client) => {
      const target = await client.query<{ merchant_id: string; role: string }>('SELECT merchant_id, role FROM invitations WHERE digest = $1', [hash]);
      if (target.rows[0]?.role === 'owner') {
        await client.query('SELECT 1 FROM trials WHERE merchant_id = $1 FOR UPDATE', [target.rows[0].merchant_id]);
      }
      const { rows } = await client.query<{ merchant_id: string; branch_id: string | null; email: string; role: string }>(`
        UPDATE invitations SET consumed_at = now() WHERE digest = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
        RETURNING merchant_id, branch_id, email, role
      `, [hash]);
      const invite = rows[0];
      if (!invite) throw new UnauthorizedException('Invitation expired or already used');
      const member = await client.query<{ id: string }>(`
        INSERT INTO memberships (merchant_id, id, subject_id, role) VALUES ($1, $2, $3, $4)
        ON CONFLICT (merchant_id, subject_id) DO NOTHING RETURNING id
      `, [invite.merchant_id, randomUUID(), invite.email, invite.role]);
      let membershipId = member.rows[0]?.id;
      if (!membershipId) {
        const existing = await client.query<{ id: string }>(`
          SELECT id FROM memberships WHERE merchant_id = $1 AND subject_id = $2 AND role = $3 AND active FOR SHARE
        `, [invite.merchant_id, invite.email, invite.role]);
        membershipId = existing.rows[0]?.id;
      }
      if (!membershipId) throw new ConflictException('This person already has a different membership');
      if (invite.branch_id) {
        await client.query('INSERT INTO branch_assignments VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [invite.merchant_id, membershipId, invite.branch_id]);
      }
      const token = secret();
      const session = await client.query<{ expires_at: Date }>(`
        INSERT INTO membership_sessions (token_digest, merchant_id, membership_id, expires_at)
        VALUES ($1, $2, $3, now() + interval '12 hours') RETURNING expires_at
      `, [digest(token), invite.merchant_id, membershipId]);
      await client.query(`
        INSERT INTO onboarding_audit (merchant_id, branch_id, membership_id, action, details)
        VALUES ($1, $2, $3, 'invitation.accepted', jsonb_build_object('role', $4::text))
      `, [invite.merchant_id, invite.branch_id, membershipId, invite.role]);
      return { merchantId: invite.merchant_id, role: invite.role, token, expiresAt: session.rows[0].expires_at };
    });
  }

  @Get('merchants/:merchantId/onboarding-registers')
  registers(@Param('merchantId') merchantId: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await owner(client, merchantId, authorization);
      const { rows } = await client.query(`
        SELECT id, branch_id AS "branchId", name, status, device_id AS "deviceId"
        FROM registers WHERE merchant_id = $1 ORDER BY name, id
      `, [merchantId]);
      return rows;
    });
  }

  @Post('merchants/:merchantId/registers/:registerId/activation-code')
  issue(@Param('merchantId') merchantId: string, @Param('registerId') registerId: string,
    @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const actor = await owner(client, merchantId, authorization);
      await allowProvisioning(client,merchantId);
      const { rows } = await client.query<{ branch_id: string; status: string }>(
        'SELECT branch_id, status FROM registers WHERE merchant_id = $1 AND id = $2 FOR UPDATE', [merchantId, registerId],
      );
      if (!rows[0]) throw new NotFoundException();
      if (rows[0].status === 'revoked') throw new ConflictException('Register was revoked');
      await client.query('UPDATE activation_codes SET consumed_at = now() WHERE merchant_id = $1 AND register_id = $2 AND consumed_at IS NULL',
        [merchantId, registerId]);
      const code = secret();
      const issued = await client.query<{ expires_at: Date }>(`
        INSERT INTO activation_codes (digest, merchant_id, branch_id, register_id, membership_id, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes') RETURNING expires_at
      `, [digest(code), merchantId, rows[0].branch_id, registerId, actor]);
      return { code, expiresAt: issued.rows[0].expires_at };
    });
  }

  @Post('devices/activate')
  activate(@Body() input: unknown) {
    const data = record(input);
    const hash = codeDigest(data.code);
    const deviceId = uuid(data.deviceId, 'device ID');
    const pairingDigest = codeDigest(data.pairingProof);
    return transaction(this.database, async (client) => {
      const { rows } = await client.query<{ merchant_id: string; branch_id: string; register_id: string; membership_id: string; status: string }>(`
        SELECT c.merchant_id, c.branch_id, c.register_id, c.membership_id, r.status
        FROM activation_codes c
        JOIN registers r ON (r.merchant_id, r.branch_id, r.id) = (c.merchant_id, c.branch_id, c.register_id)
        JOIN memberships m ON (m.merchant_id, m.id) = (c.merchant_id, c.membership_id)
        WHERE c.digest = $1 AND (r.status = 'pending' OR (r.status = 'active' AND r.device_id = $2))
          AND m.active AND m.role = 'owner'
        FOR UPDATE OF r
      `, [hash, deviceId]);
      const code = rows[0];
      if (!code) throw new UnauthorizedException('Activation code expired or already used');
      const consumed = await client.query(`
        UPDATE activation_codes SET consumed_at = now()
        WHERE digest = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
      `, [hash]);
      if (!consumed.rowCount) throw new UnauthorizedException('Activation code expired or already used');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', [deviceId]);
      const existing = await client.query(`
        SELECT 1 FROM registers WHERE device_id = $1 AND status = 'active' AND (merchant_id, id) <> ($2, $3)
      `, [deviceId, code.merchant_id, code.register_id]);
      if (existing.rowCount) throw new ConflictException('Device is already paired');
      await client.query(`
        UPDATE registers SET status = 'active', device_id = $3, activated_at = COALESCE(activated_at, now()), pairing_digest = $4
        WHERE merchant_id = $1 AND id = $2
      `, [code.merchant_id, code.register_id, deviceId, pairingDigest]);
      await client.query(`
        INSERT INTO merchant_audit (merchant_id, membership_id, branch_id, register_id, action, reason)
        VALUES ($1, $2, $3, $4, $5, 'Owner issued activation code')
      `, [code.merchant_id, code.membership_id, code.branch_id, code.register_id,
        code.status === 'pending' ? 'register.activated' : 'register.catalog_access_refreshed']);
      return { merchantId: code.merchant_id, branchId: code.branch_id, registerId: code.register_id, deviceId };
    });
  }

  @Post('devices/pairing')
  async recover(@Body() input: unknown) {
    const data = record(input);
    const deviceId = uuid(data.deviceId, 'device ID');
    const { rows } = await this.database.query(`
      SELECT merchant_id AS "merchantId", branch_id AS "branchId", id AS "registerId", device_id AS "deviceId"
      FROM registers WHERE device_id = $1 AND pairing_digest = $2 AND status = 'active'
    `, [deviceId, codeDigest(data.pairingProof)]);
    if (!rows[0]) throw new NotFoundException('No pairing for this device');
    return rows[0];
  }
}
