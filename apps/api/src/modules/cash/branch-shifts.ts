import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { cashAmount } from '@era/contracts';
import type { Pool } from 'pg';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { branchActor } from '../merchant/branch-access';
import { record, transaction, uuid } from '../onboarding/shared';

@Controller('v1/merchants/:merchantId/branches/:branchId/branch-shifts')
export class BranchShifts {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}
  @Get()
  status(@Param('merchantId') merchant: string,@Param('branchId') branch: string,@Headers('authorization') auth?: string) {
    return transaction(this.database, async client => {
      await branchActor(client,merchant,branch,['owner','manager'],auth);
      return (await client.query(`SELECT r.id,r.name,c.action,c.applied_at FROM registers r LEFT JOIN LATERAL
        (SELECT action,applied_at FROM branch_shift_commands WHERE merchant_id=r.merchant_id AND register_id=r.id
         ORDER BY sequence DESC LIMIT 1) c ON true WHERE r.merchant_id=$1 AND r.branch_id=$2 AND r.status='active' ORDER BY r.name`,
        [merchant,branch])).rows;
    });
  }
  @Post()
  change(@Param('merchantId') merchant: string,@Param('branchId') branch: string,@Body() input: unknown,@Headers('authorization') auth?: string) {
    const data = record(input);
    const id = uuid(data.id,'request ID');
    const amounts = record(data.amounts);
    if (data.action !== 'open' && data.action !== 'close') throw new BadRequestException('Invalid shift action');
    return transaction(this.database, async client => {
      await branchActor(client,merchant,branch,['owner','manager'],auth);
      await client.query('SELECT id FROM branches WHERE merchant_id=$1 AND id=$2 FOR UPDATE',[merchant,branch]);
      const previous = await client.query('SELECT register_id,action,amount FROM branch_shift_commands WHERE merchant_id=$1 AND branch_id=$2 AND request_id=$3',[merchant,branch,id]);
      if (previous.rowCount) {
        if (previous.rowCount !== Object.keys(amounts).length || previous.rows.some(row => row.action !== data.action || row.amount !== amounts[row.register_id]))
          throw new ConflictException('Request changed');
        return { queued: previous.rowCount };
      }
      const { rows } = await client.query(`SELECT r.id,c.shift_id,c.action,c.applied_at FROM registers r LEFT JOIN LATERAL
        (SELECT shift_id,action,applied_at FROM branch_shift_commands WHERE merchant_id=r.merchant_id AND register_id=r.id
          ORDER BY sequence DESC LIMIT 1) c ON true WHERE r.merchant_id=$1 AND r.branch_id=$2 AND r.status='active'`,[merchant,branch]);
      const targets = data.action === 'close' ? rows.filter(row => row.action === 'open') : rows;
      if (!targets.length) throw new ConflictException('No eligible counters');
      for (const row of targets) {
        if (row.action === data.action || (row.action && !row.applied_at)) throw new ConflictException('Wait for counters to apply the previous branch shift');
        const amount = amounts[row.id];
        if (!cashAmount(amount) || Number(amount) > 2147483647) throw new BadRequestException('Enter cash for each counter');
        await client.query(`INSERT INTO branch_shift_commands(request_id,merchant_id,branch_id,register_id,shift_id,action,amount)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,merchant,branch,row.id,data.action === 'open' ? id : row.shift_id,data.action,amount]);
      }
      return { queued: targets.length };
    });
  }
}
