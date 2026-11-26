import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Headers, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { branchActor } from '../merchant/branch-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { digest, record, text, transaction, uuid } from '../onboarding/shared';
import { inventory, moveStock } from './stock';

type Line = {sku:string; quantity:number};
type Transfer = {lines:(Line & {received:number})[]; status:string; shortage_note:string|null};
const roles = ['owner','manager'] as const;

function quantities(input:unknown):Line[] {
  if (!Array.isArray(input) || !input.length || input.length>500) throw new BadRequestException('Enter 1 to 500 transfer lines');
  const lines = input.map(value=>{
    const item = record(value);
    const quantity = item.quantity;
    if (typeof quantity!=='number' || !Number.isInteger(quantity) || quantity<1 || quantity>1000000)
      throw new BadRequestException('Enter a positive whole quantity up to 1000000');
    return {sku:text(item.sku,'SKU',80),quantity};
  }).sort((a,b)=>a.sku<b.sku?-1:a.sku>b.sku?1:0);
  if (new Set(lines.map(line=>line.sku)).size!==lines.length) throw new BadRequestException('List each SKU once');
  return lines;
}

async function incoming(client:PoolClient, merchant:string, branch:string, id:string) {
  const result=await client.query<Transfer>(`SELECT lines,status,shortage_note FROM stock_transfers
    WHERE merchant_id=$1 AND destination=$2 AND id=$3 FOR UPDATE`,[merchant,branch,id]);
  if (!result.rowCount) throw new NotFoundException('Incoming transfer not found at this branch');
  return result.rows[0];
}

@Controller('v1/merchants/:merchant/branches/:branch/transfers')
export class Transfers {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database:Pool) {}

  @Post()
  dispatch(@Param('merchant') merchant:string,@Param('branch') branch:string,@Body() body:unknown,@Headers('authorization') auth?:string) {
    return transaction(this.database,async client=>{
      const actor=await branchActor(client,merchant,branch,roles,auth);
      const data=record(body);
      const reference=text(data.reference,'dispatch reference',100);
      const destination=text(data.destination,'destination branch',120);
      if (branch===destination) throw new BadRequestException('Select a different destination branch');
      const lines=quantities(data.lines);
      const hash=digest(JSON.stringify([destination,lines]));
      const key=[merchant,branch,reference];
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['transfer',...key])]);
      const prior=await client.query('SELECT id,digest FROM stock_transfers WHERE merchant_id=$1 AND origin=$2 AND reference=$3',key);
      if (prior.rowCount) {
        if (prior.rows[0].digest!==hash) throw new ConflictException('Dispatch reference already used');
        return {id:prior.rows[0].id,duplicate:true};
      }
      const skus=lines.map(line=>line.sku);
      const destinationItems=await client.query('SELECT sku FROM branch_catalog WHERE merchant_id=$1 AND branch_id=$2 AND sku=ANY($3)',[merchant,destination,skus]);
      if (destinationItems.rowCount!==lines.length) throw new BadRequestException('All transfer SKUs must be in the destination catalog');
      const available=await inventory(client,[merchant,branch],skus);
      const bySku=new Map(available.map(item=>[item.sku,item]));
      const saved=lines.map(line=>{
        const item=bySku.get(line.sku)!;
        if (line.quantity>item.onHand) throw new ConflictException('Insufficient sellable stock for '+line.sku);
        return {...line,product:item.product,received:0};
      });
      const id=randomUUID();
      await client.query(`INSERT INTO stock_transfers(merchant_id,origin,reference,destination,id,digest,lines,status,dispatched_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,'in_transit',$8)`,[...key,destination,id,hash,JSON.stringify(saved),actor]);
      await moveStock(client,[merchant,branch],'transfer_out',lines.map(line=>({...line,quantity:-line.quantity})));
      return {id,duplicate:false};
    });
  }

  @Post(':id/receive')
  receive(@Param('merchant') merchant:string,@Param('branch') branch:string,@Param('id') input:string,@Body() body:unknown,@Headers('authorization') auth?:string) {
    return transaction(this.database,async client=>{
      const actor=await branchActor(client,merchant,branch,roles,auth);
      const data=record(body);
      const id=uuid(input,'transfer ID');
      const reference=text(data.reference,'receiving reference',100);
      const lines=quantities(data.lines);
      const transfer=await incoming(client,merchant,branch,id);
      const key=[merchant,id,reference];
      const serialized=JSON.stringify(lines);
      const prior=await client.query('SELECT lines=$4::jsonb AS matches FROM stock_transfer_receipts WHERE merchant_id=$1 AND transfer_id=$2 AND reference=$3',[...key,serialized]);
      if (prior.rowCount) {
        if (!prior.rows[0].matches) throw new ConflictException('Receiving reference already used');
        return {id,duplicate:true};
      }
      if (['received','short'].includes(transfer.status)) throw new ConflictException('Transfer is closed');
      const bySku=new Map(transfer.lines.map(line=>[line.sku,line]));
      for (const line of lines) {
        const sent=bySku.get(line.sku);
        if (!sent || line.quantity>sent.quantity-sent.received) throw new ConflictException('Quantity exceeds the outstanding transfer for '+line.sku);
        sent.received+=line.quantity;
      }
      await inventory(client,[merchant,branch],lines.map(line=>line.sku));
      await moveStock(client,[merchant,branch],'transfer_in',lines);
      await client.query('INSERT INTO stock_transfer_receipts(merchant_id,transfer_id,reference,lines,received_by) VALUES($1,$2,$3,$4,$5)',[...key,serialized,actor]);
      const status=transfer.lines.every(line=>line.received===line.quantity)?'received':'partial';
      await client.query('UPDATE stock_transfers SET lines=$3,status=$4 WHERE merchant_id=$1 AND id=$2',[merchant,id,JSON.stringify(transfer.lines),status]);
      return {id,duplicate:false};
    });
  }

  @Post(':id/shortage')
  closeShort(@Param('merchant') merchant:string,@Param('branch') branch:string,@Param('id') input:string,@Body() body:unknown,@Headers('authorization') auth?:string) {
    return transaction(this.database,async client=>{
      const actor=await branchActor(client,merchant,branch,roles,auth);
      const id=uuid(input,'transfer ID');
      const reason=text(record(body).reason,'shortage reason',500);
      const transfer=await incoming(client,merchant,branch,id);
      if (transfer.status==='received' || (transfer.status==='short' && transfer.shortage_note!==reason)) throw new ConflictException('Transfer is closed');
      if (transfer.status!=='short') await client.query("UPDATE stock_transfers SET status='short',shortage_note=$3,closed_by=$4 WHERE merchant_id=$1 AND id=$2",[merchant,id,reason,actor]);
      return {id,status:'short'};
    });
  }
}
