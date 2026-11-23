import { useRef, useState } from 'react';
import { Action, Field, request, values } from '../onboarding';

type Trial = {
  merchantId: string; name: string; plan: string; country: string; ownerEmail: string;
  branchLimit: number; registerLimit: number; ownerAccepted: boolean; pairedRegisters: number;
  branches: Array<{ id: string; name: string; storeType: string }>;
};

function StoreType({ initial = 'mixed' }: { initial?: string }) {
  return <label>Store type<select name="storeType" defaultValue={initial}>
    <option value="mixed">General / Mixed retail</option><option value="apparel">Apparel &amp; footwear</option>
    <option value="stationery">Stationery</option><option value="home_goods">Home goods</option>
    <option value="packaged_grocery">Packaged grocery</option>
  </select></label>;
}

export function PlatformHome() {
  const [token, setToken] = useState('');
  const [trials, setTrials] = useState<Trial[]>([]);
  const retry = useRef<{ details: string; id: string } | undefined>(undefined);
  async function refresh(access: string) {
    setTrials(await request<Trial[]>('platform/trials', access));
  }
  return <section aria-labelledby="platform-title">
    <h2 id="platform-title">ERA operations</h2>
    {!token ? <Action title="Open operations console" run={async (form) => {
      const access = values(form).token.trim();
      await refresh(access);
      setToken(access);
      return '';
    }}><Field name="token" label="Operator access token" type="password" /></Action> : <>
      <button onClick={() => { setToken(''); setTrials([]); }}>Lock console</button>
      <Action title="Create trial" run={async (form) => {
        const data = values(form);
        const details = JSON.stringify(data);
        if (retry.current?.details !== details) retry.current = { details, id: crypto.randomUUID() };
        await request('platform/trials', token, {
          ...data, requestId: retry.current.id, branchLimit: Number(data.branchLimit), registerLimit: Number(data.registerLimit),
        });
        await refresh(token);
        return 'Trial saved';
      }}>
        <Field name="name" label="Display name" /><Field name="legalName" label="Legal name" />
        <Field name="email" label="Owner email" type="email" />
        <label>Country<select name="country"><option value="IN">India</option><option value="US">United States</option></select></label>
        <Field name="plan" label="Plan code" initial="pilot" />
        <Field name="branchLimit" label="Branch allowance" type="number" initial="1" />
        <Field name="registerLimit" label="Register allowance" type="number" initial="1" />
      </Action>
      <Action title="Refresh trials" run={async () => { await refresh(token); return 'Trials updated'; }} />
      {trials.map((trial) => {
        const path = `platform/trials/${trial.merchantId}`;
        return <details key={trial.merchantId}>
          <summary>{trial.name} · {trial.country} · {trial.ownerAccepted ? 'Owner joined' : 'Waiting for owner'}</summary>
          <p>{trial.plan} plan · {trial.branches.length}/{trial.branchLimit} branches · {trial.pairedRegisters}/{trial.registerLimit} registers paired</p>
          <Action title="Issue owner invitation" run={async () => {
            const { code } = await request<{ code: string }>(`${path}/owner-invitation`, token, {});
            return `Share privately with ${trial.ownerEmail}. Code expires in 24 hours: ${code}`;
          }} />
          <Action title="Create branch" run={async (form) => {
            await request(`${path}/branches`, token, values(form));
            await refresh(token);
            return 'Branch created';
          }}>
            <Field name="name" label="Branch name" />
            <Field name="timezone" label="Timezone" initial={trial.country === 'IN' ? 'Asia/Kolkata' : 'America/New_York'} />
            <StoreType />
          </Action>
          {trial.branches.map((branch) => <Action key={branch.id} title={`Update store type for ${branch.name}`} run={async (form) => {
            await request(`${path}/branches/${branch.id}/store-type`, token, values(form), 'PATCH');
            await refresh(token);
            return 'Store type saved';
          }}><StoreType initial={branch.storeType} /></Action>)}
        </details>;
      })}
    </>}
  </section>;
}
