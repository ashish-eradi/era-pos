import { BadGatewayException,BadRequestException,Body,ConflictException,Controller,Headers,Inject,NotFoundException,Post,ServiceUnavailableException } from '@nestjs/common';
import { receiptText } from '@era/contracts';
import type { CashReceiptV1 } from '@era/contracts';
import type { Pool } from 'pg';
import { deviceScope } from '../merchant/branch-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { digest,email,record,text,transaction,uuid } from '../onboarding/shared';

@Controller('v1/devices')
export class DigitalReceipts {
  constructor(@Inject(MERCHANT_DATABASE) private readonly db:Pool) {}

  @Post('send-receipt')
  async send(@Body() input:unknown,@Headers('authorization') auth?:string) {
    const data=record(input);
    const channel=data.channel;
    if (channel!=='email' && channel!=='sms' && channel!=='whatsapp') throw new BadRequestException('Select email, SMS or WhatsApp');
    const recipient=channel==='email' ? email(data.recipient) : text(data.recipient,'mobile number',16);
    if (channel!=='email' && !/^\+[1-9]\d{6,14}$/.test(recipient)) throw new BadRequestException('Use an international mobile number');
    const id=uuid(data.id,'receipt');
    const device=uuid(data.deviceId,'device');
    const from=process.env.ERA_RECEIPT_FROM || process.env.ERA_SIGNUP_FROM;
    const smsAccount=process.env.ERA_TWILIO_ACCOUNT;
    const mobileFrom=channel==='whatsapp' ? process.env.ERA_WHATSAPP_FROM : process.env.ERA_SMS_FROM;
    const job=await transaction(this.db,async client=>{
      const [merchant,branch,register]=await deviceScope(client,device,auth);
      const sale=await client.query<{receipt:CashReceiptV1;occurred_at:Date}>('SELECT receipt,occurred_at FROM cash_sales WHERE merchant_id=$1 AND branch_id=$2 AND register_id=$3 AND operation_id=$4',[merchant,branch,register,id]);
      if (!sale.rowCount) throw new NotFoundException('Sync the saved sale before sending its receipt');
      const key=[merchant,register,id,channel,digest(recipient)];
      const deliveryId=digest(JSON.stringify(key));
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[deliveryId]);
      const prior=await client.query(`SELECT status,created_at,updated_at FROM receipt_deliveries WHERE
        (merchant_id,register_id,operation_id,channel,recipient_hash)=($1,$2,$3,$4,$5)`,key);
      const existing=prior.rows[0];
      if (existing?.status==='accepted') return null;
      if (existing?.status==='sending' && (channel!=='email' || Date.now()-existing.updated_at.getTime()<30000 ||
          Date.now()-existing.created_at.getTime()>=86400000)) throw new ConflictException('Delivery is pending confirmation. Check the provider before resending.');
      if (channel==='email' ? !from || !process.env.ERA_RESEND_KEY : !smsAccount || !process.env.ERA_TWILIO_TOKEN || !mobileFrom)
        throw new ServiceUnavailableException('Receipt delivery provider is not configured');
      const body=receiptText(sale.rows[0].receipt,id,sale.rows[0].occurred_at,register);
      if (channel==='sms' && body.length>1600) throw new BadRequestException('This receipt exceeds the SMS limit. Select email.');
      await client.query(`INSERT INTO receipt_deliveries(merchant_id,register_id,operation_id,channel,recipient_hash,status)
        VALUES ($1,$2,$3,$4,$5,'sending') ON CONFLICT(merchant_id,register_id,operation_id,channel,recipient_hash)
        DO UPDATE SET status='sending',updated_at=now()`,key);
      return {key,body,deliveryId};
    });
    if (!job) return {accepted:true};
    const testOrigin=process.env.NODE_ENV==='test' && process.env.ERA_RECEIPT_TEST_ORIGIN;
    let response:Response;
    try {
      const options={method:'POST',redirect:'error' as const,signal:AbortSignal.timeout(8000)};
      response=channel==='email' ? await fetch(new URL('/emails',testOrigin || 'https://api.resend.com'),{...options,
        headers:{authorization:'Bearer '+process.env.ERA_RESEND_KEY,'content-type':'application/json','Idempotency-Key':job.deliveryId},
        body:JSON.stringify({from,to:[recipient],subject:'Your sale receipt',text:job.body})}) :
        await fetch(new URL('/2010-04-01/Accounts/'+smsAccount+'/Messages.json',testOrigin || 'https://api.twilio.com'),{...options,
          headers:{authorization:'Basic '+Buffer.from(smsAccount+':'+process.env.ERA_TWILIO_TOKEN).toString('base64')},
          body:new URLSearchParams({From:(channel==='whatsapp'?'whatsapp:':'')+mobileFrom!,To:(channel==='whatsapp'?'whatsapp:':'')+recipient,Body:job.body})});
    } catch {throw new BadGatewayException('Provider acknowledgement unavailable');}
    const status=response.ok ? 'accepted' : response.status>=400 && response.status<500 && response.status!==408 ? 'retry' : 'sending';
    await this.db.query(`UPDATE receipt_deliveries SET status=$6,updated_at=now() WHERE
      (merchant_id,register_id,operation_id,channel,recipient_hash)=($1,$2,$3,$4,$5)`,[...job.key,status]);
    if (!response.ok) throw new BadGatewayException('Receipt provider did not accept delivery');
    return {accepted:true};
  }
}
