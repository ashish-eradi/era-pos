import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CounterBridge } from '../bridge';
import './style.css';

declare global {
  interface Window {
    counter: CounterBridge;
  }
}

function Counter() {
  const [status, setStatus] = useState('Checking local storage…');

  useEffect(() => {
    void window.counter.storageStatus().then(
      ({ schemaVersion }) => setStatus(`Ready · schema version ${schemaVersion}`),
      () => setStatus('Local storage is unavailable. Restart the counter to retry.'),
    );
  }, []);

  return <main>
    <h1>ERA POS Counter</h1>
    <section aria-labelledby="storage-title">
      <h2 id="storage-title">Local storage</h2>
      <p role="status">{status}</p>
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Counter />);
