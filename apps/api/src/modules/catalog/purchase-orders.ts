import { validQuantity,lineAmount } from '@era/contracts';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Headers, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { branchActor } from '../merchant/branch-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { digest, record, text, transaction, uuid } from '../onboarding/shared';

type Line = { sku:string; product:string; quantity:number; unitCostMinor:number; received:number };
type Scope = [string,string];
const roles = ['owner','manager'] as const;

export async function receivePurchase(client:PoolClient, scope:Scope, id:string, delivery:{sku:string;quantity:number}[]) {
  const result = await client.query<{lines:Line[];status:string}>(`SELECT lines,status FROM purchase_orders
    WHERE merchant_id=$1 AND branch_id=$2 AND id=$3 FOR UPDATE`,[...scope,id]);
  const order = result.rows[0];
  if (!order) throw new NotFoundException('Purchase order not found');
  if (!['open','partial'].includes(order.status)) throw new ConflictException('This purchase order is closed');
  const bySku = new Map(order.lines.map(line=>[line.sku,line]));
  for (const item of delivery) {
    const line = bySku.get(item.sku);
    if (!line || item.quantity > Math.round((line.quantity-line.received)*1000)/1000) throw new ConflictException('Delivery exceeds the outstanding order for '+item.sku);
    line.received = Math.round((line.received+item.quantity)*1000)/1000;
  }
  const status = order.lines.every(line=>line.received===line.quantity) ? 'received' : 'partial';
  await client.query('UPDATE purchase_orders SET lines=$4,status=$5 WHERE merchant_id=$1 AND branch_id=$2 AND id=$3',
    [...scope,id,JSON.stringify(order.lines),status]);
}

@Controller('v1/merchants/:merchant/branches/:branch/purchase-orders')
export class PurchaseOrders {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database:Pool) {}

  @Post()
  create(@Param('merchant') merchant:string,@Param('branch') branch:string,@Body() body:unknown,@Headers('authorization') auth?:string) {
    return transaction(this.database,async client=>{
      const actor = await branchActor(client,merchant,branch,roles,auth);
      const input = record(body);
      const reference = text(input.reference,'purchase order reference',100);
      const supplier = text(input.supplier,'supplier',160);
      if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length>500) throw new BadRequestException('Enter 1 to 500 order lines');
      const lines = input.lines.map(value=>{
        const item = record(value);
        const {quantity,unitCostMinor} = item;
        if (!validQuantity(quantity,true) || quantity>1000000 ||
          typeof unitCostMinor!=='number' || !Number.isInteger(unitCostMinor) || unitCostMinor<0 || unitCostMinor>1000000000)
          throw new BadRequestException('Enter a positive quantity and a nonnegative whole unit cost in minor units');
        return {sku:text(item.sku,'SKU',80),quantity,unitCostMinor};
      }).sort((a,b)=>a.sku<b.sku?-1:a.sku>b.sku?1:0);
      const skus = lines.map(line=>line.sku);
      if (new Set(skus).size!==skus.length) throw new BadRequestException('List each SKU once');
      if (!Number.isSafeInteger(lines.reduce((sum,line)=>sum+lineAmount(line.unitCostMinor,line.quantity),0))) throw new BadRequestException('Order total exceeds the supported amount');
      const key = [merchant,branch,reference];
      const hash = digest(JSON.stringify([supplier,lines]));
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['purchase-order',...key])]);
      const prior = await client.query('SELECT id,digest FROM purchase_orders WHERE merchant_id=$1 AND branch_id=$2 AND reference=$3',key);
      if (prior.rowCount) {
        if (prior.rows[0].digest!==hash) throw new ConflictException('This purchase order reference is already in use');
        return {id:prior.rows[0].id,duplicate:true};
      }
      const catalog = await client.query(`SELECT c.sku,c.product,c.allow_decimal,m.country_code FROM branch_catalog c JOIN merchants m ON m.id=c.merchant_id
        WHERE c.merchant_id=$1 AND c.branch_id=$2 AND c.sku=ANY($3)`,[merchant,branch,skus]);
      if (catalog.rowCount!==skus.length) throw new NotFoundException('Select products from this branch');
      const bySku = new Map(catalog.rows.map(row=>[row.sku,row]));
      const saved = lines.map(line=>{
        const item=bySku.get(line.sku)!;
        if (!validQuantity(line.quantity,item.allow_decimal)) throw new BadRequestException('Whole quantity required for '+line.sku);
        return {...line,product:item.product,...(item.allow_decimal && {allowDecimal:true}),received:0};
      });
      const id = randomUUID();
      await client.query(`INSERT INTO purchase_orders (merchant_id,branch_id,reference,id,supplier,currency,digest,lines,status,entered_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)`,[...key,id,supplier,catalog.rows[0].country_code==='IN'?'INR':'USD',hash,JSON.stringify(saved),actor]);
      return {id,duplicate:false};
    });
  }

  @Post(':id/cancel')
  cancel(@Param('merchant') merchant:string,@Param('branch') branch:string,@Param('id') id:string,@Headers('authorization') auth?:string) {
    return transaction(this.database,async client=>{
      const actor = await branchActor(client,merchant,branch,roles,auth);
      const key = [merchant,branch,uuid(id,'purchase order')];
      const order = await client.query('SELECT status FROM purchase_orders WHERE merchant_id=$1 AND branch_id=$2 AND id=$3 FOR UPDATE',key);
      if (!order.rowCount) throw new NotFoundException();
      if (order.rows[0].status==='received') throw new ConflictException('A fully received order is closed');
      if (order.rows[0].status!=='cancelled') await client.query(`UPDATE purchase_orders SET status='cancelled',cancelled_at=now(),cancelled_by=$4
        WHERE merchant_id=$1 AND branch_id=$2 AND id=$3`,[...key,actor]);
      return {id,status:'cancelled'};
    });
  }
}
