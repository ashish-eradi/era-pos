import { useState } from 'react';
import { Action,request } from '../onboarding';
import { useMerchantData } from './useMerchantData';

export function CashierPins({path,token}:{path:string;token:string}) {
  const [revision,setRevision]=useState(0);
  const {data,error}=useMerchantData<Array<{id:string;name:string;role:string;enabled:boolean}>>(path,token,revision);
  return <section className="panel"><h3>Cashier PIN access</h3>
    {error && <p role="alert">{error}</p>}
    {data?.map(person=><details key={person.id}><summary>{person.name} · {person.role} · {person.enabled?'PIN enabled':'No PIN'}</summary>
      <Action title="Set cashier PIN" run={async form=>{
        await request(path,token,{id:person.id,pin:form.get('pin')});
        setRevision(n=>n+1);return 'Saved. Refresh staff on the counter to use the new PIN.';
      }}><label>Six-digit PIN<input name="pin" type="password" pattern="[0-9]{6}" inputMode="numeric" maxLength={6} autoComplete="new-password" required/></label></Action>
      {person.enabled && <Action title="Disable PIN" run={async()=>{await request(path,token,{id:person.id,pin:null});setRevision(n=>n+1);return 'PIN disabled';}}/>}
    </details>)}
  </section>;
}
