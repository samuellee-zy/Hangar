import { useEffect, useRef, useState } from 'react';
import type { Command, PaneChromeState } from '@shared/types';
import { Icon, type IconName } from './Icon';
import { ServiceIcon } from './ServiceIcon';
import { accentStyle } from './accent';

/**
 * A pane's bar: the title bar across the top strip (`#titlebar`), speaking for the focused pane, or
 * a header above one pane (`#header-0`…). See `main/features/pane-chrome.ts`.
 *
 * Main says what to show; this sends the commands the menus send. Every one of them is preceded by
 * focusing the pane it's for — a click in a header is also a choice of pane, and the keyboard goes
 * back into the page afterwards rather than staying in this view.
 *
 * The title bar is the window's drag handle, as the bare strip was: all of it drags but the buttons.
 * A header is a pane's: dragged, it swaps the pane with another or moves it beside one. Like a rail
 * tile, it only reports the pointer, and main — which owns the geometry — works out the drop.
 */

/** How far the pointer goes before a press on a header becomes a drag rather than a click. */
const LIFT_DISTANCE = 6;
export function PaneBar({ kind }: { kind: 'titlebar' | 'header' }) {
  const [state, setState] = useState<PaneChromeState | null>(null);
  const press = useRef<{ x: number; y: number; lifted: boolean } | null>(null);
  /** The click the browser sends after a drag's release, which is not a click. */
  const swallowClick = useRef(false);

  useEffect(() => {
    let live = true;
    // Asked for as well as listened for: a state sent before this mounted would otherwise be lost.
    void window.hangar.getPaneChrome().then((initial) => {
      if (live && initial) setState((current) => current ?? initial);
    });
    const off = window.hangar.onPaneChrome(setState);
    return () => {
      live = false;
      off();
    };
  }, []);

  const bar = state?.bar ?? null;
  const inset = kind === 'titlebar' ? (state?.inset ?? 84) : 0;

  if (!bar) return <div className={`pane-bar is-${kind} is-empty`} style={{ paddingLeft: inset }} />;

  const send = (...commands: Command[]) => {
    window.hangar.send({ type: 'focus-pane', paneId: bar.paneId });
    for (const command of commands) window.hangar.send(command);
  };
  // `aria-disabled` rather than `disabled`: a disabled button swallows the click, so pressing Back
  // with nowhere to go left the keyboard in this view. It still says it's unavailable, and the
  // click still hands the keyboard back to the page.
  const button = (icon: IconName, label: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      className="pane-bar-button"
      aria-label={label}
      title={label}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) send();
        else onClick();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon name={icon} size={14} />
    </button>
  );

  // Only a header, only with somewhere to move to, and not while maximised — the others are hidden,
  // and the only target left was the gutter, reordering panes nobody could see.
  const draggable = kind === 'header' && bar.maximised === false;
  const drag = draggable
    ? {
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
          if (event.button !== 0 || (event.target as Element).closest('button')) return;
          press.current = { x: event.clientX, y: event.clientY, lifted: false };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        },
        onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
          const current = press.current;
          if (!current) return;
          if (!current.lifted) {
            if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < LIFT_DISTANCE) return;
            current.lifted = true;
            window.hangar.send({ type: 'begin-pane-drag', paneId: bar.paneId });
          }
          window.hangar.send({ type: 'drag-tile-to', from: 'header', x: event.clientX, y: event.clientY });
        },
        onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
          const current = press.current;
          press.current = null;
          if (!current?.lifted) return;
          swallowClick.current = true;
          window.hangar.send({ type: 'drop-tile', from: 'header', x: event.clientX, y: event.clientY });
          // The click this swallows would have chosen the pane. A shaky one that became a drag
          // should still do that — and a drag that did move the pane has chosen it already.
          window.hangar.send({ type: 'focus-pane', paneId: bar.paneId });
        },
        // Taken away mid-drag — a system gesture, the window losing the pointer — is a cancel.
        onPointerCancel: () => {
          if (press.current?.lifted) window.hangar.send({ type: 'cancel-tile-drag' });
          press.current = null;
        },
      }
    : {};

  return (
    <div
      className={`pane-bar is-${kind}${bar.focused ? ' is-focused' : ''}`}
      style={{ paddingLeft: inset || undefined }}
      role="toolbar"
      aria-label={kind === 'titlebar' ? `${bar.name}, the focused pane` : `${bar.name} pane`}
      {...drag}
      // A click on the bar itself picks its pane; a double-click maximises it, the way a double-click
      // on a title bar zooms a window.
      // Focused already or not, a click sends the keyboard back to the page: clicking the header
      // focused this view, and typing afterwards went nowhere.
      onClick={
        kind === 'header'
          ? () => {
              if (swallowClick.current) swallowClick.current = false;
              else send();
            }
          : undefined
      }
      onDoubleClick={kind === 'header' && bar.maximised !== null ? () => send({ type: 'toggle-maximise-pane' }) : undefined}
    >
      <div className="pane-bar-nav">
        {button('chevron-left', 'Back', () => send({ type: 'navigate', direction: 'back', serviceId: bar.serviceId }), !bar.canGoBack)}
        {button('chevron-right', 'Forward', () => send({ type: 'navigate', direction: 'forward', serviceId: bar.serviceId }), !bar.canGoForward)}
        {button('reload', 'Reload', () => send({ type: 'reload-service', serviceId: bar.serviceId }))}
      </div>
      <div className="pane-bar-name">
        {/* No initials when there's no icon: the name is right beside it, and two letters before it
            read as a stray word. A dot of the service's colour instead. */}
        <span className="pane-bar-icon" style={accentStyle(bar.color)}>
          <ServiceIcon serviceId={bar.serviceId} initials="" name="" version={bar.iconVersion} />
        </span>
        <span className="pane-bar-service">{bar.name}</span>
        {bar.title && <span className="pane-bar-title">{bar.title}</span>}
        {bar.loading && <span className="pane-bar-loading" aria-label="Loading" />}
      </div>
      {kind === 'header' && (
        <div className="pane-bar-actions">
          {button('pop-out', 'Open in a separate window', () => send({ type: 'pop-out-service', serviceId: bar.serviceId }))}
          {bar.maximised !== null &&
            button(bar.maximised ? 'restore' : 'maximise', bar.maximised ? 'Restore panes' : 'Maximise pane', () =>
              send({ type: 'toggle-maximise-pane' }),
            )}
          {bar.maximised !== null && button('close', 'Close pane', () => send({ type: 'close-pane', paneId: bar.paneId }))}
        </div>
      )}
    </div>
  );
}
