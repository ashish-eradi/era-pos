import { useState } from 'react';
import { Action, Field, request, values } from '../onboarding';

type Plan = { code:string; amount:number; currency:string; days:number; branches:number; registers:number };
type Session = { merchantId:string; role:string; token:string };
export function Signup({ enter }: { enter:(session: Session) => Promise<void> }) {
  const [token,setToken] = useState('');
  const [plans,setPlans] = useState<Plan[]>([]);
  const [url,setUrl] = useState('');
  return <details><summary>Self-serve merchant signup</summary>
    {!token ? <>
      <Action title="Send email verification" run={async form => {
        await request('signup/email','',values(form)); return 'Check your email for a verification code.';
      }}><Field name="email" type="email" label="Owner email" /></Action>
      <Action title="Verify email" run={async form => {
        const result = await request<{token:string}>('signup/verify','',values(form));
        setPlans(await request<Plan[]>('signup/plans','')); setToken(result.token); return '';
      }}><Field name="code" label="Email verification code" /></Action>
    </> : <>
      {plans.length ? <Action title="Create payment link" run={async form => {
        const result = await request<{url?:string}>('signup/payment',token,values(form));
        setUrl(result.url ?? ''); return result.url ? '' : 'Your workspace is ready.';
      }}><Field name="name" label="Merchant name" />
        <label>Plan<select name="plan">{plans.map(plan => <option key={plan.code} value={plan.code}>{plan.code} · {
          new Intl.NumberFormat(undefined,{style:'currency',currency:plan.currency}).format(plan.amount/100)
        } for {plan.days} days · {plan.branches} branches · {plan.registers} registers</option>)}</select></label>
      </Action> : <p>Paid plans are awaiting configuration.</p>}
      {url && <a href={url} target="_blank" rel="noreferrer">Pay with Razorpay</a>}
      <Action title="Check payment and enter workspace" run={async () => {
        const result = await request<Session|{pending:true}>('signup/activate',token,{});
        if ('pending' in result) return 'Payment has not settled yet.';
        await enter(result); return '';
      }} />
    </>}
  </details>;
}
