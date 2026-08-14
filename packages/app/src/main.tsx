import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { applyTheme, initialTheme } from './ui/theme.js';
import './ui/styles.css';

// Before the first render, so the canvases read the right palette when they
// paint themselves. See ui/theme.ts.
applyTheme(initialTheme());

// The Electron window hides its title bar, so the traffic lights sit over our
// own header. Mark the root so the stylesheet can leave room for them.
if (window.oramics) document.documentElement.dataset.shell = 'electron';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
