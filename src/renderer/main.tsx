import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EmptyState } from './EmptyState';
import { FindBar } from './FindBar';
import { OverlayRoot } from './OverlayRoot';
import { Settings } from './Settings';
import { Rail } from './Rail';
import './styles.css';

// Rail and overlay are two routes of one bundle, selected by hash (see main/renderer-url.ts).
const route = window.location.hash.replace('#', '') || 'rail';
document.body.dataset['route'] = route;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {route === 'overlay' ? (
      <OverlayRoot />
    ) : route === 'settings' ? (
      <Settings />
    ) : route === 'find' ? (
      <FindBar />
    ) : route === 'empty' ? (
      <EmptyState />
    ) : (
      <Rail />
    )}
  </StrictMode>
);
