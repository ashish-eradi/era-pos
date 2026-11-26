import { useState } from 'react';

export function SendReceipt({id}:{id:string}) {
  const [channel,setChannel]=useState<'email'|'sms'>('email');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  return <details><summary>Send digital receipt</summary><form onSubmit={async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const recipient=String(new FormData(form).get('recipient')).trim();
    setBusy(true);setMessage('');
    try {await window.counter.sendReceipt(id,channel,recipient);form.reset();setMessage('Receipt accepted for delivery');}
    catch(error){setMessage(error instanceof Error?error.message:'Could not send receipt');}
    finally{setBusy(false);}
  }}><fieldset disabled={busy}><label>Send by<select value={channel} onChange={e=>{setChannel(e.target.value as 'sms'|'email');setMessage('');}}>
      <option value="email">Email</option><option value="sms">SMS</option></select></label>
    <label>{channel==='email'?'Email address':'International mobile number'}<input key={channel} type={channel==='email'?'email':'tel'} name="recipient" required/></label>
    <button>Send receipt</button>{message && <p role="status">{message}</p>}</fieldset></form></details>;
}
