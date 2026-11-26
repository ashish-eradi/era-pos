import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers,
  Inject, NotFoundException, Param, Post, UnauthorizedException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { allowProvisioning } from './subscription-access';
import { gstStates,validPolicy } from '@era/contracts';
import { defaults, transaction } from '../onboarding/shared';

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

  @Get('discount-policy')
  async discountPolicy(@Param('merchantId') id:string,@Headers('authorization') auth?:string) {
    if ((await this.member(id,auth)).role!=='owner') throw new ForbiddenException();
    const {rows}=await this.database.query('SELECT policy FROM discount_policies WHERE merchant_id=$1 ORDER BY published_at DESC LIMIT 1',[id]);
    return rows[0]?.policy ?? {cap:{kind:'flat',value:0},offers:[]};
  }

  @Post('discount-policy')
  async publishPolicy(@Param('merchantId') id:string,@Body() input:unknown,@Headers('authorization') auth?:string) {
    if ((await this.member(id,auth)).role!=='owner') throw new ForbiddenException();
    if (!validPolicy(input)) throw new BadRequestException('Check the discount limit, unique codes, values and expiry dates');
    await this.database.query('INSERT INTO discount_policies (merchant_id,id,policy) VALUES ($1,$2,$3)',[id,randomUUID(),JSON.stringify({cap:input.cap,offers:input.offers})]);
    return {saved:true};
  }

  @Get('receipt-settings')
  async receiptSettings(@Param('merchantId') id: string, @Headers('authorization') auth?: string) {
    if ((await this.member(id, auth)).role !== 'owner') throw new ForbiddenException();
    return (await this.database.query('SELECT name,coalesce(legal_name,name) AS "legalName",receipt_brand AS brand,gst_rates AS rates,gst_inclusive AS inclusive,country_code AS country,receipt_address AS address, receipt_gstin AS gstin FROM merchants WHERE id=$1', [id])).rows[0];
  }

  @Post('receipt-settings')
  async saveReceiptSettings(@Param('merchantId') id: string, @Body() data: Record<string,unknown>, @Headers('authorization') auth?: string) {
    const address = data?.address === '' ? '' : requiredText(data?.address, 'receipt address', 400);
    const gstin = data?.gstin === '' ? '' : requiredText(data?.gstin, 'GSTIN', 15).toUpperCase();
    if (gstin && !/^[A-Z0-9]{15}$/.test(gstin)) throw new BadRequestException('Enter a 15-character GSTIN');
    const name = data.name === undefined ? null : requiredText(data.name,'business name',120);
    const legalName = data.legalName === undefined ? null : requiredText(data.legalName,'legal name',120);
    let brand:Record<string,unknown>|undefined;
    if (data.brand !== undefined) {
      if (!data.brand || typeof data.brand !== 'object' || Array.isArray(data.brand)) throw new BadRequestException('Invalid receipt branding');
      brand = Object.fromEntries(Object.entries(data.brand).filter(([,v])=>v !== ''));
      for (const [key,value] of Object.entries(brand)) {
        if (typeof value !== 'string' || (key === 'logo' ? value.length>32768 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(value)
          : !['header','footer','returnPolicy'].includes(key) || value.length>800)) throw new BadRequestException('Invalid receipt text or PNG logo');
      }
    }
    if (data.rates !== undefined && (!data.rates || typeof data.rates !== 'object' || Array.isArray(data.rates) ||
      Object.entries(data.rates).some(([k,v])=>!k.trim() || k.length>80 || typeof v!=='number' || !Number.isFinite(v) || Math.abs(v*100-Math.round(v*100))>1e-8 || v<0 || v>100)))
      throw new BadRequestException('Provide GST percentages (up to two decimal places) for named categories');
    if (data.inclusive !== undefined && typeof data.inclusive !== 'boolean') throw new BadRequestException('Select a price mode');
    if (data.rates && Object.keys(data.rates).length && !Object.hasOwn(gstStates,gstin.slice(0,2))) throw new BadRequestException('Invalid supplier state in GSTIN');
    return transaction(this.database,async client=>{
      const member=await this.member(id,auth,client);
      if (member.role!=='owner') throw new ForbiddenException();
      const result = await client.query(`UPDATE merchants SET receipt_address=$2,receipt_gstin=$3,name=coalesce($4,name),
        legal_name=coalesce($5,legal_name),receipt_brand=coalesce($6::jsonb,receipt_brand),gst_rates=coalesce($7::jsonb,gst_rates),
        gst_inclusive=coalesce($8,gst_inclusive) WHERE id=$1 AND
        (coalesce($7::jsonb,gst_rates)='{}'::jsonb OR (country_code='IN' AND $3 ~ '^[0-9]{2}[A-Z0-9]{13}$' AND $2 <> ''))
        RETURNING name,coalesce(legal_name,name) AS "legalName",receipt_address AS address,receipt_gstin AS gstin,
        receipt_brand AS brand,gst_rates AS rates,gst_inclusive AS inclusive,country_code AS country`,
        [id,address,gstin,name,legalName,brand,data.rates,data.inclusive]);
      if (!result.rowCount) throw new BadRequestException('Configure an Indian business address and GSTIN before enabling GST');
      await client.query(`INSERT INTO catalog_imports (merchant_id,branch_id,digest,membership_id,version)
        SELECT b.merchant_id,b.id,$2,$3,coalesce(max(i.version),0)+1 FROM branches b LEFT JOIN catalog_imports i
        ON (i.merchant_id,i.branch_id)=(b.merchant_id,b.id) WHERE b.merchant_id=$1 GROUP BY b.merchant_id,b.id`,[id,randomUUID(),member.id]);
      return result.rows[0];
    });
  }

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
      await allowProvisioning(client,merchantId);
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
