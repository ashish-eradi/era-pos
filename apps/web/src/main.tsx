import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MerchantHome } from './merchant/MerchantHome';
import { PlatformHome } from './platform/PlatformHome';
import { SupportHome } from './platform/SupportHome';
import { ErrorBoundary } from '../../../packages/ui/ErrorBoundary';
import './style.css';

function App() {
  const [route, setRoute] = useState(location.hash);

  useEffect(() => {
    const onRouteChange = () => setRoute(location.hash);
    window.addEventListener('hashchange', onRouteChange);
    return () => window.removeEventListener('hashchange', onRouteChange);
  }, []);

  return <><header className="mast"><span className="brand">ERA POS</span>
    <nav aria-label="Workspace">
      <a href="#merchant" aria-current={route !== '#platform' && route !== '#support' ? 'page' : undefined}>Merchant</a>
      <a href="#platform" aria-current={route === '#platform' ? 'page' : undefined}>ERA operations</a>
      <a href="#support" aria-current={route === '#support' ? 'page' : undefined}>ERA support</a>
    </nav></header><main className="canvas">
    {route === '#support' ? <SupportHome /> : route === '#platform' ? <PlatformHome /> : <MerchantHome />}
  </main></>;
}

createRoot(document.getElementById('root')!).render(<ErrorBoundary workspace="Merchant and operations workspace"><App /></ErrorBoundary>);
