import { Buffer } from 'buffer';
import process from 'process';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { RootErrorBoundary } from './RootErrorBoundary';
import { ServiceProvider } from './contexts/providers/ServiceProvider';
import { ThemeProvider } from './contexts/providers/ThemeProvider';
import './index.css';
import { applyBootAccent } from './mobile/theme/accent';
import { nameFailedFetch } from './utils/nameFailedFetch';
import { installBchatFetch } from './services/bchatOrigin';
import { lazy, Suspense } from 'react';
import { SEEDLESS_ENABLED } from './mobile/passkey/prf';
import { takeHandCashWebReturn } from './mobile/passkey/handcashWeb';
global.Buffer = Buffer;
global.process = process;
window.Buffer = Buffer;
// "Couldn't reach <host>" instead of a bare "Load failed" (utils/nameFailedFetch.ts).
nameFailedFetch();
// bChatX requests follow the live origin (www.bchatx.com, else chat.bwalletx.com).
installBchatFetch();
// App accent (Theme → App colours) before the first paint: the extension popup/side panel and the web edition.
applyBootAccent();

// After a web deploy, an open tab asks for old chunk/CSS hashes that no longer exist ("Refused to apply style …
// MIME type text/plain"). Reload once to pick up the new build; a session flag stops a reload loop.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem('bwallet.reloadedForDeploy')) return;
    sessionStorage.setItem('bwallet.reloadedForDeploy', '1');
  } catch {
    return;
  }
  e.preventDefault();
  window.location.reload();
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element');
const rootDiv = ReactDOM.createRoot(root);
// Back from "Continue with HandCash" on the web welcome (identity only).
if (SEEDLESS_ENABLED) takeHandCashWebReturn();
// Passkey PRF diagnostic (VITE_SEEDLESS=1 builds only), outside the wallet lock so it works on a fresh browser.
const PasskeyCheck = SEEDLESS_ENABLED
  ? lazy(() => import('./mobile/passkey/PasskeyCheck').then((m) => ({ default: m.PasskeyCheck })))
  : null;
if (PasskeyCheck && location.pathname.replace(/\/$/, '').endsWith('/passkey-check')) {
  rootDiv.render(
    <Suspense fallback={null}>
      <PasskeyCheck />
    </Suspense>,
  );
} else
  rootDiv.render(
    <RootErrorBoundary>
      <ServiceProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </ServiceProvider>
    </RootErrorBoundary>,
  );
