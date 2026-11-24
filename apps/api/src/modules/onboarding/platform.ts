import { randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, Inject,
  NotFoundException, Param, Patch, Post, UnauthorizedException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { allowProvisioning } from '../merchant/subscription-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { bearer, defaults, digest, email, record, secret, text, transaction, uuid } from './shared';

function allowance(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new BadRequestException(`Provide a valid ${field} between 1 and 1000`);
  }
  return value;
}

function storeType(value: unknown): keyof typeof defaults {
  if (typeof value !== 'string' || !Object.hasOwn(defaults, value)) throw new BadRequestException('Select a store type');
  return value as keyof typeof defaults;
}

async function admin(database: Pool | PoolClient, authorization?: string): Promise<string> {
  const { rows } = await database.query<{ id: string; role: string }>(`
    SELECT o.id, o.role FROM platform_sessions s JOIN platform_operators o ON o.id = s.operator_id
    WHERE s.digest = $1 AND s.expires_at > now()
  `, [bearer(authorization)]);
  if (!rows[0]) throw new UnauthorizedException();
  if (rows[0].role !== 'admin') throw new ForbiddenException();
  return rows[0].id;
}

@Controller('v1/platform')
export class PlatformController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Get('trials')
  async trials(@Headers('authorization') authorization?: string) {
    await admin(this.database, authorization);
    const { rows } = await this.database.query(`
      SELECT t.merchant_id AS "merchantId", m.name, m.country_code AS country, t.owner_email AS "ownerEmail",
        e.plan_code AS plan, e.branch_limit AS "branchLimit", e.register_limit AS "registerLimit",
        EXISTS (SELECT 1 FROM memberships a WHERE a.merchant_id = t.merchant_id AND a.role = 'owner' AND a.active) AS "ownerAccepted",
        (SELECT count(*)::int FROM registers r WHERE r.merchant_id = t.merchant_id AND r.status = 'active') AS "pairedRegisters",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'storeType', b.store_type, 'timezone', b.timezone) ORDER BY b.name, b.id)
          FROM branches b WHERE b.merchant_id = t.merchant_id), '[]'::jsonb) AS branches
      FROM trials t JOIN merchants m ON m.id = t.merchant_id JOIN entitlements e ON e.merchant_id = t.merchant_id
      ORDER BY t.created_at DESC, t.merchant_id
    `);
    return rows;
  }

  @Post('trials')
  trial(@Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const operator = await admin(client, authorization);
      const data = record(input);
      const requestId = uuid(data.requestId, 'request ID');
      const name = text(data.name, 'display name');
      const legalName = text(data.legalName, 'legal name');
      const contact = email(data.email);
      const country = data.country;
      if (country !== 'IN' && country !== 'US') throw new BadRequestException('Select IN or US');
      const plan = text(data.plan, 'plan', 40);
      const branchLimit = allowance(data.branchLimit, 'branch limit');
      const registerLimit = allowance(data.registerLimit, 'register limit');
      const hash = digest(JSON.stringify([name, legalName, contact, country, plan, branchLimit, registerLimit]));
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [requestId]);
      const existing = await client.query<{ merchant_id: string; request_hash: string; operator_id: string }>(
        'SELECT merchant_id, request_hash, operator_id FROM trials WHERE request_id = $1', [requestId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash || existing.rows[0].operator_id !== operator) {
          throw new ConflictException('Request ID is already in use');
        }
        return { merchantId: existing.rows[0].merchant_id };
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [contact]);
      const duplicate = await client.query('SELECT 1 FROM trials WHERE owner_email = $1', [contact]);
      if ((await client.query('SELECT 1 FROM merchant_signups WHERE email=$1 AND plan IS NOT NULL',[contact])).rowCount)
        throw new ConflictException('A signup already uses this owner email');
      if (duplicate.rowCount) throw new ConflictException('A trial already uses this owner email');
      const merchantId = randomUUID();
      await client.query('INSERT INTO merchants (id, name, country_code, legal_name) VALUES ($1, $2, $3, $4)',
        [merchantId, name, country, legalName]);
      await client.query('INSERT INTO entitlements (merchant_id, plan_code, register_limit, branch_limit) VALUES ($1, $2, $3, $4)',
        [merchantId, plan, registerLimit, branchLimit]);
      await client.query('INSERT INTO trials (merchant_id, operator_id, request_id, request_hash, owner_email) VALUES ($1, $2, $3, $4, $5)',
        [merchantId, operator, requestId, hash, contact]);
      await client.query("INSERT INTO onboarding_audit (merchant_id, operator_id, action, details) VALUES ($1, $2, 'trial.created', '{}')",
        [merchantId, operator]);
      return { merchantId };
    });
  }

  @Post('trials/:merchantId/owner-invitation')
  invite(@Param('merchantId') merchantId: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const operator = await admin(client, authorization);
      const { rows } = await client.query<{ owner_email: string }>('SELECT owner_email FROM trials WHERE merchant_id = $1 FOR UPDATE', [merchantId]);
      if (!rows[0]) throw new NotFoundException();
      await client.query("UPDATE invitations SET consumed_at = now() WHERE merchant_id = $1 AND role = 'owner' AND consumed_at IS NULL", [merchantId]);
      const code = secret();
      const issued = await client.query<{ expires_at: Date }>(`
        INSERT INTO invitations (digest, merchant_id, email, role, expires_at)
        VALUES ($1, $2, $3, 'owner', now() + interval '24 hours') RETURNING expires_at
      `, [digest(code), merchantId, rows[0].owner_email]);
      await client.query(`
        INSERT INTO onboarding_audit (merchant_id, operator_id, action, details)
        VALUES ($1, $2, 'owner.invited', '{}')
      `, [merchantId, operator]);
      return { code, expiresAt: issued.rows[0].expires_at };
    });
  }

  @Post('trials/:merchantId/branches')
  branch(@Param('merchantId') merchantId: string, @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const operator = await admin(client, authorization);
      await allowProvisioning(client,merchantId);
      const data = record(input);
      const name = text(data.name, 'branch name');
      const timezone = text(data.timezone, 'timezone');
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new BadRequestException('Provide an IANA timezone'); }
      const type = storeType(data.storeType);
      const { rows } = await client.query<{ branch_limit: number }>(`
        SELECT e.branch_limit FROM entitlements e JOIN trials t ON t.merchant_id = e.merchant_id
        WHERE e.merchant_id = $1 FOR UPDATE OF e
      `, [merchantId]);
      if (!rows[0]) throw new NotFoundException();
      const usage = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM branches WHERE merchant_id = $1', [merchantId]);
      if (usage.rows[0].count >= rows[0].branch_limit) throw new ConflictException('Branch allowance reached');
      const id = randomUUID();
      await client.query('INSERT INTO branches (merchant_id, id, name, timezone, store_type) VALUES ($1, $2, $3, $4, $5)',
        [merchantId, id, name, timezone, type]);
      await client.query(`
        INSERT INTO onboarding_audit (merchant_id, branch_id, operator_id, action, details)
        VALUES ($1, $2, $3, 'branch.created', jsonb_build_object('storeType', $4::text))
      `, [merchantId, id, operator, type]);
      return { id, name, timezone, storeType: type, catalogDefaults: defaults[type] };
    });
  }

  @Patch('trials/:merchantId/branches/:branchId/store-type')
  changeType(@Param('merchantId') merchantId: string, @Param('branchId') branchId: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const operator = await admin(client, authorization);
      const type = storeType(record(input).storeType);
      const { rows } = await client.query<{ store_type: string }>(`
        SELECT b.store_type FROM branches b JOIN trials t ON t.merchant_id = b.merchant_id
        WHERE b.merchant_id = $1 AND b.id = $2 FOR UPDATE OF b
      `, [merchantId, branchId]);
      if (!rows[0]) throw new NotFoundException();
      if (rows[0].store_type !== type) {
        await client.query('UPDATE branches SET store_type = $3 WHERE merchant_id = $1 AND id = $2', [merchantId, branchId, type]);
        await client.query(`
          INSERT INTO onboarding_audit (merchant_id, branch_id, operator_id, action, details)
          VALUES ($1, $2, $3, 'branch.store_type_changed', jsonb_build_object('previous', $4::text, 'current', $5::text))
        `, [merchantId, branchId, operator, rows[0].store_type, type]);
      }
      return { storeType: type, catalogDefaults: defaults[type] };
    });
  }
}
