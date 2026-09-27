import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { DragLayer } from './DragLayer';
import { ErrorBoundary } from './ErrorBoundary';
import { FindBar } from './FindBar';
import './styles.css';

// Every surface is a route of one app, selected by hash (see main/renderer-url.ts), and the large
// ones are chunks of their own. They were one bundle, so the drag layer, the find bar and the empty
// view each parsed Settings, the picker and the whole catalog to draw a rectangle or a text field.
//
// The drag layer and the find bar stay in the entry, and not for size — they're a kilobyte each.
// Main talks to them the moment their view exists: a drag's first highlight arrives while the page
// is still loading, and a lazy component isn't listening yet, so it was lost.
const named = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((module) => ({ default: module[name] })));

const Rail = named(() => import('./Rail'), 'Rail');
const OverlayRoot = named(() => import('./OverlayRoot'), 'OverlayRoot');
const Settings = named(() => import('./Settings'), 'Settings');
const EmptyState = named(() => import('./EmptyState'), 'EmptyState');

const route = window.location.hash.replace('#', '') || 'rail';
document.body.dataset['route'] = route;

// One boundary here rather than five at the call sites: every route is a whole `WebContentsView`,
// so the blast radius of an uncaught render error is the entire surface either way. See
// `ErrorBoundary` for why an empty root is worse in Electron than on the web.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary route={route}>
      {/* No fallback: a chunk loads from disk in a few milliseconds, and a spinner for that would
          only be a flash. */}
      <Suspense fallback={null}>
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
      </Suspense>
    </ErrorBoundary>
  </StrictMode>
);
