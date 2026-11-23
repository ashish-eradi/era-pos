import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers,
  Inject, NotFoundException, Param, Post, UnauthorizedException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { defaults } from '../onboarding/shared';

export const MERCHANT_DATABASE = Symbol('MERCHANT_DATABASE');

type Member = {
  id: string;
  role: 'owner' | 'manager' | 'cashier' | 'accountant';
};

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || value.includes('\0')) {
    throw new BadRequestException(`Provide a valid ${field}`);
  }
  return value.trim();
}

@Controller('v1/merchants/:merchantId')
export class MerchantController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  private async member(
    merchantId: string, authorization: string | undefined, database: Pool | PoolClient = this.database,
  ): Promise<Member> {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
    if (!token) throw new UnauthorizedException();
    const digest = createHash('sha256').update(token).digest('hex');
    const { rows } = await database.query<Member>(`
      SELECT m.id, m.role
      FROM membership_sessions s
      JOIN memberships m ON m.merchant_id = s.merchant_id AND m.id = s.membership_id
      WHERE s.token_digest = $1 AND s.merchant_id = $2 AND m.active
        AND s.revoked_at IS NULL AND s.expires_at > now()
    `, [digest, merchantId]);
    if (!rows[0]) throw new UnauthorizedException();
    return rows[0];
  }

  @Get('branches')
  async branches(@Param('merchantId') merchantId: string, @Headers('authorization') authorization?: string) {
    const member = await this.member(merchantId, authorization);
    const { rows } = await this.database.query<{ id: string; name: string; timezone: string; storeType: keyof typeof defaults }>(`
      SELECT b.id, b.name, b.timezone, b.store_type AS "storeType" FROM branches b
      WHERE b.merchant_id = $1 AND ($2 OR EXISTS (
        SELECT 1 FROM branch_assignments a
        WHERE a.merchant_id = b.merchant_id AND a.branch_id = b.id AND a.membership_id = $3
      ))
      ORDER BY b.id
    `, [merchantId, member.role === 'owner', member.id]);
    return rows.map((branch) => ({ ...branch, catalogDefaults: defaults[branch.storeType] }));
  }

  @Get('barcodes/:barcode')
  async barcode(
    @Param('merchantId') merchantId: string,
    @Param('barcode') barcode: string,
    @Headers('authorization') authorization?: string,
  ) {
    const member = await this.member(merchantId, authorization);
    const { rows } = await this.database.query<{ barcode: string; sku: string }>(`
      SELECT barcode, sku FROM catalog_barcodes
      WHERE merchant_id = $1 AND barcode = $2 AND ($3 OR EXISTS (
        SELECT 1 FROM branch_assignments WHERE merchant_id = $1 AND membership_id = $4
      ))
    `, [merchantId, barcode, member.role === 'owner', member.id]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  @Post('branches/:branchId/registers')
  async register(
    @Param('merchantId') merchantId: string,
    @Param('branchId') branchId: string,
    @Body() input: { name?: unknown; reason?: unknown } | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const member = await this.member(merchantId, authorization, client);
      if (member.role !== 'owner') throw new ForbiddenException();
      const name = requiredText(input?.name, 'register name', 100);
      const reason = requiredText(input?.reason, 'reason', 500);
      const branch = await client.query('SELECT 1 FROM branches WHERE merchant_id = $1 AND id = $2', [merchantId, branchId]);
      if (!branch.rowCount) throw new NotFoundException();
      const entitlement = await client.query<{ register_limit: number }>(
        'SELECT register_limit FROM entitlements WHERE merchant_id = $1 FOR UPDATE', [merchantId],
      );
      const limit = entitlement.rows[0]?.register_limit ?? 0;
      const usage = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM registers WHERE merchant_id = $1 AND status <> 'revoked'", [merchantId],
      );
      if (usage.rows[0].count >= limit) throw new ConflictException('Register allowance reached');
      const id = randomUUID();
      await client.query('INSERT INTO registers (merchant_id, id, branch_id, name) VALUES ($1, $2, $3, $4)',
        [merchantId, id, branchId, name]);
      await client.query(`
        INSERT INTO merchant_audit (merchant_id, membership_id, branch_id, register_id, action, reason)
        VALUES ($1, $2, $3, $4, 'register.created', $5)
      `, [merchantId, member.id, branchId, id, reason]);
      await client.query('COMMIT');
      return { id, branchId, name, status: 'pending' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('exports')
  async requestExport(@Param('merchantId') merchantId: string, @Headers('authorization') authorization?: string) {
    const member = await this.member(merchantId, authorization);
    if (member.role !== 'owner') throw new ForbiddenException();
    const id = randomUUID();
    await this.database.query(
      'INSERT INTO merchant_exports (merchant_id, id, membership_id) VALUES ($1, $2, $3)', [merchantId, id, member.id],
    );
    return { id, status: 'pending' };
  }

  @Get('exports/:exportId')
  async export(
    @Param('merchantId') merchantId: string,
    @Param('exportId') exportId: string,
    @Headers('authorization') authorization?: string,
  ) {
    const member = await this.member(merchantId, authorization);
    if (member.role !== 'owner') throw new ForbiddenException();
    const { rows } = await this.database.query<{ result: unknown }>(
      'SELECT result FROM merchant_exports WHERE merchant_id = $1 AND id = $2', [merchantId, exportId],
    );
    if (!rows[0]) throw new NotFoundException();
    return rows[0].result === null ? { status: 'pending' } : { status: 'complete', result: rows[0].result };
  }
}
