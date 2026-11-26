import { useState } from 'react';

export function SendReceipt({id}:{id:string}) {
  const [channel,setChannel]=useState<'email'|'sms'|'whatsapp'|'whatsapp-draft'>('email');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  return <section className="receipt-actions" aria-label="Send digital receipt"><form onSubmit={async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const recipient=String(new FormData(form).get('recipient')).trim();
    setBusy(true);setMessage('');
    try {await window.counter.sendReceipt(id,channel,recipient);form.reset();setMessage(channel==='whatsapp-draft'?'WhatsApp draft opened. Review and send it in WhatsApp.':'Receipt accepted for delivery');}
    catch(error){setMessage(error instanceof Error?error.message:'Could not send receipt');}
    finally{setBusy(false);}
  }}><fieldset disabled={busy}><label>Send by<select value={channel} onChange={e=>{setChannel(e.target.value as typeof channel);setMessage('');}}>
      <option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp Business</option><option value="whatsapp-draft">WhatsApp draft</option></select></label>
    <label>{channel==='email'?'Email address':'International mobile number'}<input key={channel} type={channel==='email'?'email':'tel'} name="recipient" required/></label>
    <button>{channel==='whatsapp-draft'?'Open WhatsApp draft':'Send receipt'}</button>{message && <p role="status">{message}</p>}</fieldset></form></section>;
}
