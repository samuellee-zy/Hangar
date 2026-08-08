import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DragLayer } from './DragLayer';
import { EmptyState } from './EmptyState';
import { ErrorBoundary } from './ErrorBoundary';
import { FindBar } from './FindBar';
import { OverlayRoot } from './OverlayRoot';
import { Settings } from './Settings';
import { Rail } from './Rail';
import './styles.css';

// Rail and overlay are two routes of one bundle, selected by hash (see main/renderer-url.ts).
const route = window.location.hash.replace('#', '') || 'rail';
document.body.dataset['route'] = route;

// One boundary here rather than five at the call sites: every route is a whole `WebContentsView`,
// so the blast radius of an uncaught render error is the entire surface either way. See
// `ErrorBoundary` for why an empty root is worse in Electron than on the web.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary route={route}>
      {route === 'overlay' ? (
        <OverlayRoot />
      ) : route === 'settings' ? (
        <Settings />
      ) : route === 'find' ? (
        <FindBar />
      ) : route === 'empty' ? (
        <EmptyState />
      ) : route === 'drag' ? (
        <DragLayer />
      ) : (
        <Rail />
      )}
    </ErrorBoundary>
  </StrictMode>
);
