import './lockdown';
import './styles/fonts.css';
import './styles/base.css';
import './styles/themes.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installLockVeil } from './lib/veil';

// Antes de React: el velo del bloqueo no depende de que la UI responda (§13.3, paso 1).
installLockVeil();

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
