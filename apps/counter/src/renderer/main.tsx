import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CounterBridge, Pairing } from '../bridge';
import type { FormEvent } from 'react';
import './style.css';

declare global {
  interface Window {
    counter: CounterBridge;
  }
}

function Counter() {
  const [status, setStatus] = useState('Checking local storage…');
  const [schemaReady, setSchemaReady] = useState(false);
  const [paired, setPaired] = useState<Pairing>();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void window.counter.storageStatus().then(
      ({ schemaVersion, pairing }) => {
        setStatus(`Ready · schema version ${schemaVersion}`);
        setSchemaReady(true);
        setPaired(pairing);
      },
      () => setStatus('Local storage is unavailable. Restart the counter to retry.'),
    );
  }, []);

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
    setError('');
    setSubmitting(true);
    try {
      setPaired(await window.counter.activate(code));
    } catch (failure) {
      const message = failure instanceof Error ? failure.message.replace(/^.*?Error: /, '').replace(/^Error: /, '') : 'Device activation failed';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return <main>
    <h1>ERA POS Counter</h1>
    <section aria-labelledby="storage-title">
      <h2 id="storage-title">Local storage</h2>
      <p role="status">{status}</p>
    </section>
    {schemaReady && <section aria-labelledby="pairing-title">
      <h2 id="pairing-title">Register pairing</h2>
      {paired ? <p>Paired to register {paired.registerId}</p> : <form onSubmit={pair}>
        <label>Activation code <input name="code" type="password" autoComplete="off" required /></label>
        <button disabled={submitting}>{submitting ? 'Pairing…' : 'Pair register'}</button>
        {error && <p role="alert">{error}</p>}
      </form>}
    </section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Counter />);
