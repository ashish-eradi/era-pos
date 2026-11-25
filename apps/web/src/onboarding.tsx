import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function request<T>(path: string, token: string, body?: object, method = body ? 'POST' : 'GET'): Promise<T> {
  const response = await fetch(`/v1/${path}`, {
    method, cache: 'no-store',
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const id = response.headers.get('x-request-id');
    const message = typeof data.message === 'string' ? data.message : 'The request failed';
    throw new ApiError(response.status,id ? `${message} (request ${id})` : message);
  }
  return data as T;
}

export function Action({ title, children, run }: { title: string; children?: ReactNode; run: (data: FormData) => Promise<string> }) {
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus('');
    try { setStatus(await run(new FormData(event.currentTarget))); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'The request failed'); }
    finally { setPending(false); }
  }
  return <form onSubmit={submit}><fieldset disabled={pending}>
    <legend>{title}</legend>{children}<button>{title}</button>
    {status && <output aria-live="polite">{status}</output>}
  </fieldset></form>;
}

export function values(data: FormData): Record<string, string> {
  const result: Record<string, string> = {};
  data.forEach((value, key) => { result[key] = String(value); });
  return result;
}

export function Field({ name, label, type = 'text', initial }: { name: string; label: string; type?: string; initial?: string }) {
  return <label>{label}<input name={name} type={type} defaultValue={initial} required /></label>;
}
