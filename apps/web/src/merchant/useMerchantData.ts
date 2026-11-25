import { useEffect, useState } from 'react';
import { request } from '../onboarding';

export function useMerchantData<T>(path: string, token: string, revision = 0, interval = 0): { data?: T; error?: string } {
  const [result,setResult] = useState<{ path: string; token: string; data?: T; error?: string }>();
  useEffect(() => {
    if (!path) return;
    let active = true;
    let timer: number | undefined;
    async function load() {
      try {
        const data = await request<T>(path,token);
        if (active) setResult({path,token,data});
      } catch (error) {
        if (active) setResult({path,token,error:error instanceof Error ? error.message : 'Request failed'});
      } finally {
        if (active && interval) timer = window.setTimeout(load,interval);
      }
    }
    void load();
    return () => { active=false; window.clearTimeout(timer); };
  },[path,token,revision,interval]);
  return result?.path === path && result.token === token ? result : {};
}
