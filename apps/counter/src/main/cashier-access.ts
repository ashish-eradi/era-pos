import { scryptSync,timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { safeStorage } from 'electron';
import type { Cashier,CashierAccess } from '../bridge';
import { apiUrl,catalogCredential,pairing } from './pairing';

type Entry=Cashier & {salt:string;verifier:string};
const idleMs=5*60_000;

export class CashierSession {
  private staff:Entry[]=[];
  private active?:Entry;
  private deadline=0;
  private registerId?:string;
  private refreshPending?:Promise<CashierAccess>;

  constructor(private db:DatabaseSync,private changed:(value:CashierAccess)=>void) { this.restore(); }

  restore() {
    this.active=undefined;
    this.staff=[];
    this.registerId=pairing(this.db)?.registerId;
    if (!this.registerId) return;
    const row=this.db.prepare('SELECT value FROM register_settings WHERE key=?').get('staff:'+this.registerId);
    if (typeof row?.value==='string') {
      try { this.staff=JSON.parse(safeStorage.decryptString(Buffer.from(row.value,'base64'))); }
      catch { this.staff=[]; }
    }
  }

  status():CashierAccess {
    this.expire();
    const identity=({id,name}:Cashier)=>({id,name});
    return {staff:this.staff.map(identity),active:this.active && identity(this.active)};
  }

  lock() {
    if (!this.active) return;
    this.active=undefined;
    this.changed(this.status());
  }

  expire() { if (Date.now()>=this.deadline) this.lock(); }

  activity() {
    this.expire();
    if (this.active) this.deadline=Date.now()+idleMs;
  }

  require():Cashier {
    this.expire();
    if (!this.active || this.registerId!==pairing(this.db)?.registerId) throw new Error('Unlock the counter with your cashier PIN');
    return {id:this.active.id,name:this.active.name};
  }

  unlock(id:string,pin:string) {
    const entry=this.staff.find(person=>person.id===id);
    if (!entry || typeof pin!=='string' || !/^\d{6}$/.test(pin)) throw new Error('Choose a cashier and enter six digits');
    const key='pin-attempt:'+this.registerId+':'+id;
    const row=this.db.prepare('SELECT value FROM register_settings WHERE key=?').get(key);
    const attempt=row ? JSON.parse(String(row.value)) : {count:0,until:0};
    if (attempt.until>Date.now()) throw new Error('Too many attempts. Try again in one minute.');
    if (!timingSafeEqual(scryptSync(pin,entry.salt,32),Buffer.from(entry.verifier,'hex'))) {
      const count=attempt.until ? 1 : attempt.count+1;
      this.db.prepare('INSERT OR REPLACE INTO register_settings VALUES (?,?)').run(key,JSON.stringify({count,until:count>=5 ? Date.now()+60000 : 0}));
      throw new Error('Incorrect cashier PIN');
    }
    this.db.prepare('DELETE FROM register_settings WHERE key=?').run(key);
    this.deadline=Date.now()+idleMs;
    this.active=entry;
    this.changed(this.status());
    return this.status();
  }

  refresh() {
    this.refreshPending ??= this.download().finally(()=>{this.refreshPending=undefined;});
    return this.refreshPending;
  }

  private async download() {
    const pair=pairing(this.db);
    if (!pair) throw new Error('Pair the counter before refreshing staff');
    const response=await fetch(apiUrl('/v1/devices/cashiers'),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'content-type':'application/json',authorization:'Bearer '+catalogCredential(this.db)},body:JSON.stringify({deviceId:pair.deviceId})});
    if (pair.registerId!==pairing(this.db)?.registerId) throw new Error('Register changed while refreshing staff');
    if (response.status===401 || response.status===403) {
      this.db.prepare('DELETE FROM register_settings WHERE key=?').run('staff:'+pair.registerId);
      this.staff=[];this.active=undefined;this.changed(this.status());
    }
    if (!response.ok) throw new Error('Could not refresh staff. Check register access and connectivity.');
    const data=await response.json() as {registerId:string;staff:Entry[]};
    if (pair.registerId!==pairing(this.db)?.registerId || data.registerId!==pair.registerId || !Array.isArray(data.staff) || data.staff.some(p=>
      !p || typeof p.id!=='string' || typeof p.name!=='string' || !/^[a-f\d]{32}$/.test(p.salt) || !/^[a-f\d]{64}$/.test(p.verifier)))
      throw new Error('Invalid branch staff response');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Local credential encryption is unavailable');
    const serialized=JSON.stringify(data.staff);
    if (pair.registerId!==this.registerId || JSON.stringify(this.staff)!==serialized) {
      const encrypted=safeStorage.encryptString(serialized).toString('base64');
      this.db.prepare('INSERT OR REPLACE INTO register_settings VALUES (?,?)').run('staff:'+pair.registerId,encrypted);
      this.active=data.staff.find(p=>p.id===this.active?.id && p.verifier===this.active.verifier && pair.registerId===this.registerId);
      this.staff=data.staff;this.registerId=pair.registerId;
      this.changed(this.status());
    }
    return this.status();
  }
}
