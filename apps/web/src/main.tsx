import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MerchantHome } from './merchant/MerchantHome';
import { PlatformHome } from './platform/PlatformHome';
import './style.css';

function App() {
  const [platform, setPlatform] = useState(location.hash === '#platform');

  useEffect(() => {
    const onRouteChange = () => setPlatform(location.hash === '#platform');
    window.addEventListener('hashchange', onRouteChange);
    return () => window.removeEventListener('hashchange', onRouteChange);
  }, []);

  return <main>
    <h1>ERA POS</h1>
    <nav aria-label="Workspace">
      <a href="#merchant" aria-current={platform ? undefined : 'page'}>Merchant</a>
      <a href="#platform" aria-current={platform ? 'page' : undefined}>ERA operations</a>
    </nav>
    {platform ? <PlatformHome /> : <MerchantHome />}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
