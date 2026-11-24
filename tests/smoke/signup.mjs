import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export async function checkSignup(port, connectionString, provider) {
  const db = new pg.Client({ connectionString });
  const plan = randomUUID();
  const email = plan+'@example.test';
  async function post(path,body,token,expected=201) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/signup/${path}`,{method:'POST',
      headers:{'content-type':'application/json',...(token && {authorization:'Bearer '+token})},body:JSON.stringify(body)});
    const data = await response.json();
    assert.equal(response.status,expected,JSON.stringify(data));
    return data;
  }
  await db.connect();
  try {
    await db.query("INSERT INTO signup_plans(code,currency,amount,days,branches,registers) VALUES($1,'INR',2500,30,1,2)",[plan]);
    await post('email',{email});
    const code = provider.emailCodes.get(email);
    const {token} = await post('verify',{code});
    await post('verify',{code},undefined,401);
    const payment = await post('payment',{name:'Test shop',plan},token);
    assert.equal(payment.url,'https://rzp.io/i/signup-test');
    assert.deepEqual(await post('activate',{},token),{pending:true});
    const {rows:[row]} = await db.query('SELECT id FROM merchant_signups WHERE email=$1',[email]);
    Object.assign(provider.links.get(row.id),{status:'paid',amount_paid:2500});
    const owner = await post('activate',{},token);
    assert.equal(owner.role,'owner');
    assert.equal((await post('activate',{},token)).merchantId,owner.merchantId);
    assert.equal((await db.query('SELECT register_limit FROM entitlements WHERE merchant_id=$1',[owner.merchantId])).rows[0].register_limit,2);
    console.log('Email verification, paid signup, automatic provisioning and activation replay passed');
  } finally {
    const { rows:[row] } = await db.query('DELETE FROM merchant_signups WHERE email=$1 RETURNING merchant_id',[email]);
    if (row?.merchant_id) {
      for (const table of ['membership_sessions','memberships','subscriptions','trials','entitlements','branches'])
        await db.query(`DELETE FROM ${table} WHERE merchant_id=$1`,[row.merchant_id]);
      await db.query('DELETE FROM merchants WHERE id=$1',[row.merchant_id]);
    }
    await db.query('DELETE FROM signup_plans WHERE code=$1',[plan]);
    await db.end();
  }
}
