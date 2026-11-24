import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { razorpay } from '../payments/razorpay';
import { bearer, digest, email, record, secret, text, transaction } from './shared';

type Plan = { code: string; currency: 'USD'|'INR'; amount: number; days: number; branches: number; registers: number };
type Signup = { email: string; id: string; name: string; plan: Plan; link_id: string; merchant_id: string; member_id: string };
async function session(client: PoolClient, auth?: string) {
  const { rows } = await client.query<Signup>('SELECT * FROM merchant_signups WHERE session_hash=$1 AND session_expires>now() FOR UPDATE',[bearer(auth)]);
  if (!rows[0]) throw new UnauthorizedException('Verify your email again');
  return rows[0];
}

async function reconcile(client: PoolClient, row: Signup) {
  if (row.merchant_id) return row;
  if (!row.link_id) throw new BadRequestException('Choose a plan first');
  const link = await razorpay.link('platform-signup',row.link_id);
  if (link.id !== row.link_id || link.reference_id !== row.id || link.amount !== row.plan.amount || link.currency !== row.plan.currency)
    throw new ConflictException('Payment details do not match the selected plan');
  if (link.status !== 'paid' || link.amount_paid !== row.plan.amount) {
    if (['expired','cancelled'].includes(link.status)) {
      await client.query('UPDATE merchant_signups SET plan=NULL,link_id=NULL,id=gen_random_uuid() WHERE email=$1',[row.email]);
    }
    return row;
  }
  const merchant = randomUUID();
  const member = randomUUID();
  const country = row.plan.currency === 'INR' ? 'IN' : 'US';
  await client.query('INSERT INTO merchants(id,name,legal_name,country_code) VALUES($1,$2,$2,$3)',[merchant,row.name,country]);
  await client.query('INSERT INTO trials(merchant_id,request_id,request_hash,owner_email) VALUES($1,$2,$3,$4)',[merchant,row.id,digest(row.id),row.email]);
  await client.query('INSERT INTO entitlements(merchant_id,plan_code,branch_limit,register_limit) VALUES($1,$2,$3,$4)',[merchant,row.plan.code,row.plan.branches,row.plan.registers]);
  await client.query('INSERT INTO branches(merchant_id,id,name,timezone) VALUES($1,$2,$3,$4)',[merchant,randomUUID(),row.name,country === 'IN' ? 'Asia/Kolkata' : 'UTC']);
  await client.query("INSERT INTO memberships(merchant_id,id,subject_id,role) VALUES($1,$2,$3,'owner')",[merchant,member,row.email]);
  await client.query('INSERT INTO subscriptions(merchant_id,paid_through) VALUES($1,current_date+$2::int-1)',[merchant,row.plan.days]);
  await client.query('UPDATE merchant_signups SET merchant_id=$1,member_id=$2 WHERE email=$3',[merchant,member,row.email]);
  return { ...row, merchant_id: merchant, member_id: member };
}

export async function provisionNextSignup(database: Pool) {
  await transaction(database, async client => {
    const { rows: [row] } = await client.query<Signup>(`UPDATE merchant_signups SET next_check=now()+interval '1 minute'
      WHERE email=(SELECT email FROM merchant_signups WHERE link_id IS NOT NULL AND merchant_id IS NULL AND next_check<=now()
      ORDER BY next_check LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
    if (row) {
      // Keep the retry delay if the provider is unavailable.
      await client.query('SAVEPOINT provision_signup');
      try { await reconcile(client,row); }
      catch {
        await client.query('ROLLBACK TO SAVEPOINT provision_signup');
        console.error(JSON.stringify({ event:'signup.provision_retry', signupId:row.id }));
      }
    }
  });
}

@Controller('v1/signup')
export class MerchantSignup {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}
  @Get('plans')
  async plans() {
    return (await this.database.query('SELECT code,currency,amount,days,branches,registers FROM signup_plans WHERE available ORDER BY code')).rows;
  }
  @Post('email')
  send(@Body() input: unknown) {
    const address = email(record(input).email);
    const from = process.env.ERA_SIGNUP_FROM;
    if (!from || !process.env.ERA_RESEND_KEY) throw new ServiceUnavailableException('Email signup is awaiting configuration');
    return transaction(this.database, async client => {
      if (!(await client.query(`SELECT 1 FROM signup_plans WHERE available
        UNION ALL SELECT 1 FROM merchant_signups WHERE email=$1 AND plan IS NOT NULL LIMIT 1`,[address])).rowCount)
        throw new ServiceUnavailableException('Paid signup is awaiting plan configuration');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('signup-email-rate'))");
      const recent = await client.query("SELECT count(*)::int AS count FROM merchant_signups WHERE sent_at>now()-interval '1 minute'");
      if (recent.rows[0].count >= 30) throw new ServiceUnavailableException('Try email verification again shortly');
      const code = secret();
      const result = await client.query(`INSERT INTO merchant_signups(email,code_hash) VALUES($1,$2)
        ON CONFLICT(email) DO UPDATE SET code_hash=EXCLUDED.code_hash,sent_at=now()
        WHERE merchant_signups.sent_at<now()-interval '1 minute'`,[address,digest(code)]);
      if (result.rowCount) {
        const origin = process.env.NODE_ENV === 'test' && process.env.ERA_SIGNUP_TEST_ORIGIN || 'https://api.resend.com';
        const response = await fetch(new URL('/emails',origin),{ method: 'POST',redirect:'error',signal:AbortSignal.timeout(6000),
          headers:{authorization:`Bearer ${process.env.ERA_RESEND_KEY}`,'content-type':'application/json'},
          body:JSON.stringify({from,to:[address],subject:'Verify your ERA POS email',text:`Your ERA POS verification code is ${code}. It expires in 15 minutes.`}) });
        if (!response.ok) throw new ServiceUnavailableException('Verification email could not be sent');
      }
      return { sent: true };
    });
  }
  @Post('verify')
  async verify(@Body() input: unknown) {
    const token = secret();
    const result = await this.database.query(`UPDATE merchant_signups SET code_hash=$1,session_hash=$2,session_expires=now()+interval '1 day'
      WHERE code_hash=$3 AND sent_at>now()-interval '15 minutes'`,[digest(secret()),digest(token),digest(text(record(input).code,'verification code',43))]);
    if (!result.rowCount) throw new UnauthorizedException('Verification code is invalid or expired');
    return { token };
  }
  @Post('payment')
  async payment(@Body() input: unknown,@Headers('authorization') auth?: string) {
    await transaction(this.database, async client => {
      const row = await session(client,auth);
      if (row.merchant_id) return { active: true };
      const data = record(input);
      const name = text(data.name,'merchant name');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[row.email]);
      if ((await client.query('SELECT 1 FROM trials WHERE owner_email=$1',[row.email])).rowCount)
        throw new ConflictException('An account already uses this email');
      const plan = row.plan ?? (await client.query<Plan>('SELECT * FROM signup_plans WHERE code=$1 AND available',[text(data.plan,'plan')])).rows[0];
      if (!plan || plan.code !== data.plan) throw new BadRequestException('Select the original or an available plan');
      await client.query('UPDATE merchant_signups SET plan=$1,name=$2 WHERE email=$3',[JSON.stringify(plan),name,row.email]);
    });
    return transaction(this.database, async client => {
      const row = await session(client,auth);
      if (row.merchant_id) return { active:true };
      const plan = row.plan;
      const link = await razorpay.find('platform-signup',row.id) ?? await razorpay.signup(row.id,plan.amount,plan.currency);
      if (link.reference_id !== row.id || link.amount !== plan.amount || link.currency !== plan.currency || !link.short_url.startsWith('https://'))
        throw new ConflictException('Payment link does not match the plan');
      await client.query('UPDATE merchant_signups SET link_id=$1 WHERE email=$2',[link.id,row.email]);
      return { url: link.short_url };
    });
  }
  @Post('activate')
  activate(@Headers('authorization') auth?: string) {
    return transaction(this.database, async client => {
      const row = await reconcile(client,await session(client,auth));
      if (!row.merchant_id) return { pending: true };
      const token = secret();
      await client.query(`INSERT INTO membership_sessions(token_digest,merchant_id,membership_id,expires_at)
        VALUES($1,$2,$3,now()+interval '1 day')`,[digest(token),row.merchant_id,row.member_id]);
      return { merchantId: row.merchant_id,role:'owner',token };
    });
  }
}
