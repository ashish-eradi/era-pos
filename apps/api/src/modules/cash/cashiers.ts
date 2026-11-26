import { BadRequestException, Body, Controller, Get, Headers, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { branchActor, deviceScope } from '../merchant/branch-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { record, text, transaction, uuid } from '../onboarding/shared';

const deriveKey = promisify(scrypt);
const roster = `FROM memberships m LEFT JOIN cashier_pins p ON p.merchant_id=m.merchant_id AND p.membership_id=m.id AND p.branch_id=$2
  WHERE m.merchant_id=$1 AND m.active AND (m.role='owner' OR (m.role IN ('manager','cashier') AND EXISTS (
    SELECT 1 FROM branch_assignments a WHERE (a.merchant_id,a.membership_id,a.branch_id)=(m.merchant_id,m.id,$2))))`;

@Controller('v1')
export class Cashiers {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database:Pool) {}

  @Get('merchants/:merchant/branches/:branch/cashiers')
  list(@Param('merchant') merchant:string,@Param('branch') branch:string,@Headers('authorization') auth?:string) {
    return transaction(this.database,async client=>{
      await branchActor(client,merchant,branch,['owner'],auth);
      return (await client.query(`SELECT m.id,m.subject_id AS name,m.role,p.verifier IS NOT NULL AS enabled ${roster} ORDER BY name`,[merchant,branch])).rows;
    });
  }

  @Post('merchants/:merchant/branches/:branch/cashiers')
  setPin(@Param('merchant') merchant:string,@Param('branch') branch:string,@Body() input:unknown,@Headers('authorization') auth?:string) {
    return transaction(this.database,async client=>{
      await branchActor(client,merchant,branch,['owner'],auth);
      const data=record(input);
      const id=text(data.id,'cashier',120);
      if (!(await client.query(`SELECT m.id ${roster} AND m.id=$3`,[merchant,branch,id])).rowCount) throw new NotFoundException('Select an active branch member');
      if (data.pin===null) {
        await client.query('DELETE FROM cashier_pins WHERE merchant_id=$1 AND branch_id=$2 AND membership_id=$3',[merchant,branch,id]);
      } else {
        if (typeof data.pin!=='string' || !/^\d{6}$/.test(data.pin)) throw new BadRequestException('Enter a six-digit PIN');
        const salt=randomBytes(16).toString('hex');
        const verifier=(await deriveKey(data.pin,salt,32) as Buffer).toString('hex');
        await client.query(`INSERT INTO cashier_pins(merchant_id,branch_id,membership_id,salt,verifier) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (merchant_id,branch_id,membership_id) DO UPDATE SET salt=excluded.salt,verifier=excluded.verifier`,[merchant,branch,id,salt,verifier]);
      }
      return {enabled:data.pin!==null};
    });
  }

  @Post('devices/cashiers')
  download(@Body() input:unknown,@Headers('authorization') auth?:string) {
    return transaction(this.database,async client=>{
      const [merchant,branch,registerId]=await deviceScope(client,uuid(record(input).deviceId,'device ID'),auth);
      const result=await client.query(`SELECT m.id,m.subject_id AS name,p.salt,p.verifier ${roster} AND p.verifier IS NOT NULL ORDER BY name`,[merchant,branch]);
      return {registerId,staff:result.rows};
    });
  }
}
