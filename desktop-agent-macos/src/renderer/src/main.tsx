import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createMockApi } from './mock-api';
import './style.css';

/**
 * In Electron the preload always defines window.agentAPI.
 *
 * For design review without Electron, build with VITE_MOCK=1 and the renderer
 * falls back to an in-memory mock. In a normal build the flag is undefined, so
 * the branch and the mock module are dropped by tree-shaking.
 */
if (import.meta.env.VITE_MOCK === '1' && !window.agentAPI) {
  window.agentAPI = createMockApi();
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
