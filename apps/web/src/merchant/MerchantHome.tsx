import { useEffect, useState } from 'react';
import { Action, ApiError, Field, request, values } from '../onboarding';
import { useMerchantData } from './useMerchantData';
import type { StockAlert } from './Overview';
import { CatalogImport } from './CatalogImport';
import { Customers } from './Customers';
import { CashSales } from './CashSales';
import { Subscription } from './Subscription';
import { Inventory } from './Inventory';
import { DailyClose } from './DailyClose';
import { ReturnApprovals } from './ReturnApprovals';
import { SupportTickets } from './SupportTickets';
import { UpiPayments } from './UpiPayments';
import { BranchShifts } from './BranchShifts';
import { Overview } from './Overview';
import { CashierPins } from './CashierPins';
import { DiscountSettings } from './DiscountSettings';
import { ReceiptSettings } from './ReceiptSettings';
import { Signup } from './Signup';

type Session = { merchantId: string; role: string; token: string };
type Branch = { id: string; name: string; timezone: string; catalogDefaults: string[] };
type Register = { id: string; branchId: string; name: string; status: string };
const sessionKey = 'era.merchant.session';
function savedSession(): Session | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(sessionKey) ?? 'null');
    if (value && typeof value.token === 'string' && typeof value.merchantId === 'string' &&
      ['owner','manager','cashier','accountant'].includes(value.role)) return value;
  } catch { /* Storage may be unavailable in private browsing. */ }
}

import { ChartColumn, Tags, Users, Boxes, Undo2, Store, Receipt, Settings, Wallet, Calendar, Plug, LifeBuoy } from 'lucide-react';
const sectionIcons:Record<string,typeof Store>={Overview:ChartColumn,Catalog:Tags,Customers:Users,Inventory:Boxes,Returns:Undo2,'Team and registers':Store,Sales:Receipt,Discounts:Tags,'Receipt settings':Settings,Payments:Wallet,Subscription:Calendar,Integrations:Plug,Support:LifeBuoy};
function SectionIcon({name}:{name:string}) {const Icon=sectionIcons[name] ?? Store;return <Icon aria-hidden="true" size={18}/>;}
export function MerchantHome() {
  const [menu,setMenu] = useState(false);
  const [session, setSession] = useState(savedSession);
  const [section, setSection] = useState(session?.role === 'accountant' ? 'Sales' : 'Overview');
  const [failure,setFailure] = useState('');
  const [stockRevision,refreshStock] = useState(0);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [branchId,setBranchId] = useState("");
  const [businessDate,setBusinessDate] = useState("");
  const branch = branches.find(item => item.id === branchId) ?? branches[0];
  const date = new Intl.DateTimeFormat("sv-SE",{timeZone:branch?.timezone}).format(new Date());
  const stockPath = branch && session && ['owner','manager'].includes(session.role)
    ? `merchants/${session.merchantId}/branches/${branch.id}/inventory/alerts` : '';
  const stock = useMerchantData<StockAlert[]>(stockPath,session?.token ?? '',stockRevision,30000);
  async function loadWorkspace(active: Session) {
    const path = `merchants/${active.merchantId}`;
    const [stores, counters] = await Promise.all([
      request<Branch[]>(`${path}/branches`, active.token),
      active.role === 'owner' ? request<Register[]>(`${path}/onboarding-registers`, active.token) : Promise.resolve([]),
    ]);
    return {stores,counters};
  }
  async function refresh(active: Session) {
    const {stores,counters} = await loadWorkspace(active);
    setBranches(stores); setRegisters(counters); setFailure('');
  }
  useEffect(() => {
    try {
      if (session) localStorage.setItem(sessionKey,JSON.stringify(session));
      else localStorage.removeItem(sessionKey);
    } catch { /* The current tab can still use its in-memory session. */ }
    if (!session) return;
    let active = true;
    void loadWorkspace(session).then(({stores,counters})=>{
      if (active) { setBranches(stores); setRegisters(counters); setFailure(''); }
    }).catch(error=>{
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) {
        setSession(undefined); setBranches([]); setRegisters([]); setBranchId('');
      }
      setFailure(String(error.message));
    });
    return () => { active=false; };
  },[session]);
  async function enter(active: Session) {
    setSection(active.role === 'accountant' ? 'Sales' : 'Overview');
    setFailure(''); setSession(active);
  }
  return <section className={session ? "merchant-shell" : "access-shell"} aria-labelledby="merchant-title">
    {!session && <div className="access-cover"><div className="store-art" aria-hidden="true"><i/><b/><em/></div><h2 id="merchant-title">Merchant<br/>workspace</h2></div>}
    {failure && <p role="alert">{failure}</p>}
    {!session ? <div className="access-form"><Signup enter={enter} /><Action title="Accept invitation" run={async (form) => {
      const active = await request<Session>('invitations/accept', '', { code: values(form).code.trim() });
      await enter(active);
      return '';
    }}><Field name="code" label="Invitation code" type="password" /></Action></div> : <>
      <aside className={menu ? "rail expanded" : "rail"}><button className="menu-trigger" aria-expanded={menu} onClick={()=>setMenu(!menu)}>Workspace menu</button><h2 id="merchant-title">Workspace</h2>
      <nav className="tabs" aria-label="Merchant sections">{['Overview', ...(session.role === 'owner' ? ['Catalog'] : []),
        ...(['owner','manager'].includes(session.role) ? ['Customers','Inventory','Returns','Team and registers'] : []),
        ...(['owner','manager','accountant'].includes(session.role) ? ['Sales'] : []),
        ...(session.role === 'owner' ? ['Discounts','Receipt settings','Payments','Subscription','Integrations','Support'] : [])].map(name =>
          <button key={name} aria-current={section === name ? 'page' : undefined} onClick={() => {setSection(name);setMenu(false);}}><SectionIcon name={name}/>{name}{name === 'Inventory' && !!stock.data?.length && <span className="stock-count" aria-label={`${stock.data.length} low-stock items`}>{stock.data.length}</span>}</button>)}</nav>
        <button className="quiet" onClick={() => {setSection('Overview');setSession(undefined);setBranches([]);setRegisters([]);setBranchId('');setBusinessDate('');}}>End local session</button>
      </aside><article className="desk"><header className="section-head"><h1><SectionIcon name={section}/> {section}</h1>
      <label>Branch<select value={branch?.id ?? ''} onChange={e=>{setBranchId(e.target.value);setBusinessDate('');}}>
      {branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label></header>
      {section === 'Overview' && branch && (session.role === 'cashier' ? <p>Use your paired counter to open a shift and sell in {branch.name}.</p> : <>
        <Overview key={branch.id} date={date} path={`merchants/${session.merchantId}/branches/${branch.id}`} token={session.token} stock={stock.data} stockError={stock.error} sales={day=>{setBusinessDate(day);setSection('Sales');}} /></>)}
      {!branches.length && <Action title="Refresh branches" run={async()=>{await refresh(session);return '';}}/>}
      {section === 'Discounts' && session.role === 'owner' && <DiscountSettings path={`merchants/${session.merchantId}/discount-policy`} token={session.token}/>}
      {section === 'Receipt settings' && session.role === 'owner' && <ReceiptSettings key={session.merchantId} path={`merchants/${session.merchantId}/receipt-settings`} token={session.token}/>}
      {section === 'Subscription' && session.role === 'owner' && <Subscription path={`merchants/${session.merchantId}`} token={session.token} />}
      {section === 'Sales' && branch && session.role === 'owner' && <CashSales path={`merchants/${session.merchantId}/cash-sales?branch=${encodeURIComponent(branch.id)}`} token={session.token} />}
      {section === 'Customers' && branch && ['owner','manager'].includes(session.role) && <Customers key={branch.id} path={`merchants/${session.merchantId}/branches/${branch.id}/customers`} token={session.token} timezone={branch.timezone}/>}
      {section === 'Support' && session.role === 'owner' && <SupportTickets merchantId={session.merchantId} token={session.token} />}
      {section === 'Integrations' && session.role === 'owner' && <>
        <Action title="Register sales webhook" run={async form => {
          const result = await request<{ signingKey: string }>(`merchants/${session.merchantId}/webhook`,session.token,{ url: form.get('url') });
          return `Store this signing key privately: ${result.signingKey}`;
        }}><Field name="url" label="Accounting system HTTPS endpoint" type="url" /></Action>
        <Action title="Remove webhook and pending deliveries" run={async () => {
          await request(`merchants/${session.merchantId}/webhook`,session.token,undefined,'DELETE'); return 'Webhook removed';
        }}><label><input type="checkbox" required/>Discard outstanding webhook deliveries for this account</label></Action></>}
      {section === 'Payments' && session.role === 'owner' && <UpiPayments path={`merchants/${session.merchantId}/upi`} token={session.token} />}
      {!branches.length && <p>No assigned branches.</p>}
      {['Catalog','Inventory','Sales','Returns','Team and registers'].includes(section) && branches.filter(b=>b.id === branch?.id).map((branch) => {
        const path = `merchants/${session.merchantId}`;
        return <div key={branch.id}>
          <h3>{branch.name}</h3>
          {section === 'Team and registers' && ['owner','manager'].includes(session.role) &&
            <BranchShifts path={`${path}/branches/${branch.id}/branch-shifts`} token={session.token} />}
          <p>{branch.timezone}{branch.catalogDefaults.length > 0 && ` · Suggested catalog attributes: ${branch.catalogDefaults.join(', ')}`}</p>
          {['owner','manager','accountant'].includes(session.role) && section === 'Sales' && <DailyClose path={`${path}/branches/${branch.id}`}
            initialDate={businessDate || date} token={session.token} timezone={branch.timezone} canApprove={session.role !== 'accountant'} />}
          {['owner','manager'].includes(session.role) && section === 'Inventory' && <Inventory branchName={branch.name} branchPath={`${path}/branches/${branch.id}`} token={session.token} changed={()=>refreshStock(n=>n+1)} />}
          {['owner', 'manager'].includes(session.role) && section === 'Returns' && <ReturnApprovals path={`${path}/branches/${branch.id}/returns`} token={session.token} />}
          {section === 'Catalog' && session.role === 'owner' && <CatalogImport path={`${path}/branches/${branch.id}/catalog`} token={session.token} />}
          {section === 'Team and registers' && session.role === 'owner' && <>
            <CashierPins path={`${path}/branches/${branch.id}/cashiers`} token={session.token}/>
            <Action title="Invite branch staff" run={async (form) => {
              const { code } = await request<{ code: string }>(`${path}/branches/${branch.id}/staff-invitations`, session.token, values(form));
              return `Share privately. Code expires in 24 hours: ${code}`;
            }}>
              <Field name="email" label="Staff email" type="email" />
              <label>Role<select name="role"><option value="manager">Manager</option><option value="cashier">Cashier</option><option value="accountant">Accountant</option></select></label>
            </Action>
            <Action title="Reserve register" run={async (form) => {
              await request(`${path}/branches/${branch.id}/registers`, session.token, values(form));
              await refresh(session);
              return 'Register reserved';
            }}><Field name="name" label="Register name" /><Field name="reason" label="Reason" /></Action>
            {registers.filter(({ branchId }) => branchId === branch.id).map((register) => <div key={register.id}>
              <p>{register.name} · {register.status}</p>
              {register.status === 'active' && <Action title="Authorize cash discount" run={async (form) => {
                const data = values(form);
                const { approval } = await request<{ approval: string }>(`${path}/registers/${register.id}/cash-discount`, session.token,
                  { operationId: data.operationId, amount: Number(data.amount) });
                return `Give the cashier this approval code: ${approval}`;
              }}>
                <Field name="operationId" label="Sale ID from counter" />
                <Field name="amount" label="Discount (minor units)" type="number" />
              </Action>}
              {register.status !== 'revoked' && <Action title={register.status === 'pending' ? 'Generate activation code' : 'Generate catalog access code'} run={async () => {
                const { code } = await request<{ code: string }>(`${path}/registers/${register.id}/activation-code`, session.token, {});
                return `Enter on the register within 10 minutes: ${code}`;
              }} />}
            </div>)}
          </>}
        </div>;
      })}</article>
    </>}
  </section>;
}
