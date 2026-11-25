import { useEffect, useState } from 'react';
import { Action, request, values } from '../onboarding';

type Settings = { name:string; legalName:string; address:string; gstin:string; country:string; inclusive:boolean; rates:Record<string,number>;
  brand:{header?:string;footer?:string;returnPolicy?:string;logo?:string} };

export function ReceiptSettings({ path, token }: { path: string; token: string }) {
  const [settings, setSettings] = useState<Settings>();
  const [rates,setRates] = useState<Array<[string,string]>>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request<Settings>(path, token).then(result => { if (active) {setSettings(result);setRates(Object.entries(result.rates ?? {}).map(([k,v])=>[k,String(v)]));} })
      .catch(failure => { if (active) setError(String(failure.message)); });
    return () => { active = false; };
  }, [path, token]);
  if (error) return <p role="alert">{error}</p>;
  if (!settings) return <p role="status">Loading receipt settings…</p>;
  return <Action title="Save receipt details" run={async form => {
    const {name,legalName,address,gstin,header,footer,returnPolicy} = values(form);
    let logo = form.has('removeLogo') ? '' : settings.brand.logo;
    const file = form.get('logo');
    if (file instanceof File && file.size) {
      if (file.type !== 'image/png' || file.size>24000) throw new Error('Choose a PNG logo up to 24 KB');
      logo = await new Promise<string>((resolve,reject)=>{const reader=new FileReader();
        reader.onload=()=>resolve(String(reader.result)); reader.onerror=()=>reject(new Error('Could not read logo')); reader.readAsDataURL(file);});
    }
    if (new Set(rates.map(([k])=>k.trim())).size !== rates.length) throw new Error('Use one rate per category');
    setSettings(await request<Settings>(path, token, {name,legalName,address,gstin,brand:{header,footer,returnPolicy,logo},
      rates:Object.fromEntries(rates.map(([k,v])=>[k.trim(),Number(v)])), inclusive:form.has('inclusive')}));
    return 'Saved. Download the catalog on each counter to use these details for new sales.';
  }}>
    <label>Business name<input name="name" required maxLength={120} defaultValue={settings.name}/></label>
    <label>Legal name<input name="legalName" required maxLength={120} defaultValue={settings.legalName}/></label>
    <label>Logo (PNG, up to 24 KB)<input type="file" name="logo" accept="image/png"/></label>
    {settings.brand.logo && <label><input name="removeLogo" type="checkbox"/>Remove current logo</label>}
    <label>Receipt header<textarea name="header" maxLength={800} defaultValue={settings.brand.header}/></label>
    <label>Receipt footer<textarea name="footer" maxLength={800} defaultValue={settings.brand.footer}/></label>
    <label>Return policy<textarea name="returnPolicy" maxLength={800} defaultValue={settings.brand.returnPolicy}/></label>
    {settings.country==='IN' && <fieldset><legend>GST by catalog category</legend>
      <label><input type="checkbox" name="inclusive" defaultChecked={settings.inclusive}/>Catalog prices include GST</label>
      {rates.map(([category,rate],i)=><div key={i}><label>Category<input required maxLength={80} value={category} onChange={e=>setRates(rates.map((row,n)=>n===i?[e.target.value,rate]:row))}/></label>
        <label>GST %<input type="number" required min={0} max={100} step=".01" value={rate} onChange={e=>setRates(rates.map((row,n)=>n===i?[category,e.target.value]:row))}/></label>
        <button type="button" onClick={()=>setRates(rates.filter((_,n)=>n!==i))}>Remove rate</button></div>)}
      <button type="button" onClick={()=>setRates([...rates,['','']])}>Add category rate</button></fieldset>}
    <label>Business address<textarea name="address" maxLength={400} defaultValue={settings.address}/></label>
    <label>GSTIN (if registered)<input name="gstin" pattern="[A-Za-z0-9]{15}" maxLength={15} defaultValue={settings.gstin}/></label>
  </Action>;
}
