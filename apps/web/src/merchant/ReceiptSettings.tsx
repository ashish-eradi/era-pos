import { useEffect, useState } from 'react';
import { Action, request, values } from '../onboarding';

type Settings = { address: string; gstin: string };

export function ReceiptSettings({ path, token }: { path: string; token: string }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request<Settings>(path, token).then(result => { if (active) setSettings(result); })
      .catch(failure => { if (active) setError(String(failure.message)); });
    return () => { active = false; };
  }, [path, token]);
  if (error) return <p role="alert">{error}</p>;
  if (!settings) return <p role="status">Loading receipt settings…</p>;
  return <Action title="Save receipt details" run={async form => {
    setSettings(await request<Settings>(path, token, values(form)));
    return 'Saved. Download the catalog on each counter to use these details for new sales.';
  }}>
    <label>Business address<textarea name="address" maxLength={400} defaultValue={settings.address}/></label>
    <label>GSTIN (if registered)<input name="gstin" pattern="[A-Za-z0-9]{15}" maxLength={15} defaultValue={settings.gstin}/></label>
  </Action>;
}
