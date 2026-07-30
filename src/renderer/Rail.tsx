import { brightenForDark } from './accent';
import { FolderTile } from './FolderTile';
import { ServiceIcon } from './ServiceIcon';
import { SortableRailList, SortableTile } from './SortableRail';
import { useShellState } from './useShellState';
import type { ServiceView } from '../shared/types';

/**
 * The icon rail. Renders `ShellState.railItems` — an ordered tree of top-level services and
 * folders — and holds no state of its own.
 *
 * Drag reorders the *top level*. Moving a service into or out of a folder goes through the
 * right-click menu: cross-container nested dragging in dnd-kit is fiddly enough that shipping it
 * half-working would be worse than a menu that always does what it says.
 */
export function Rail() {
  const state = useShellState();
  if (!state) return null;

  const visible = new Set(state.panes.map((p) => p.serviceId));
  const focusedServiceId = state.panes.find((p) => p.id === state.focusedPaneId)?.serviceId;
  const { railPosition, railSize, showLabels, density, compactRail } =
    state.preferences.appearance;
  // Top and bottom lay the rail out as a row; the tile treatment is otherwise identical.
  const horizontal = railPosition === 'top' || railPosition === 'bottom';
  const byId = new Map(state.services.map((s) => [s.id, s]));
  const send = window.hangar.send;

  const renderService = (svc: ServiceView, nested = false) => {
    const classes = [
      'rail-item',
      nested ? 'is-nested' : '',
      visible.has(svc.id) ? 'is-visible' : '',
      svc.id === focusedServiceId ? 'is-focused' : '',
      svc.loading ? 'is-loading' : '',
      svc.sleeping ? 'is-sleeping' : '',
      svc.id === state.flashServiceId ? 'is-flashing' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <>
        <button
          className={classes}
          // Identity lives in the accent and the icon; the tile surface carries state only.
          style={{ ['--accent' as string]: brightenForDark(svc.color) }}
          title={`${svc.name}${svc.sleeping ? ' (asleep)' : ''}`}
          onContextMenu={(e) => {
            e.preventDefault();
            send({ type: 'show-service-menu', serviceId: svc.id });
          }}
          onClick={(e) =>
            send(
              // ⌥-click opens alongside rather than replacing — the mouse equivalent of ⌘\.
              e.altKey
                ? { type: 'open-in-new-pane', serviceId: svc.id }
                : { type: 'focus-service', serviceId: svc.id }
            )
          }
        >
          <ServiceIcon serviceId={svc.id} initials={svc.initials} name={svc.name} />
          {svc.unread > 0 && <span className="rail-badge">{svc.unread}</span>}
        </button>
        {showLabels && !compactRail && !horizontal && (
          <span className="rail-label">{svc.name}</span>
        )}
      </>
    );
  };

  return (
    <div
      className={[
        'rail',
        `is-${railPosition}`,
        horizontal ? 'is-horizontal' : 'is-vertical',
        `is-${density}`,
        compactRail ? 'is-compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ ['--rail-size' as string]: `${compactRail ? 48 : railSize}px` }}
      onContextMenu={(e) => {
        e.preventDefault();
        send({ type: 'show-rail-menu' });
      }}
    >
      {/* Clear of the traffic lights, and the window's drag handle. */}
      <div className="rail-drag" />

      <SortableRailList
        ids={state.railItems.map((i) => i.id)}
        onReorder={(itemIds) => send({ type: 'reorder-items', itemIds })}
      >
        <nav className="rail-items">
          {state.railItems.map((item) => {
            if (item.kind === 'service') {
              const svc = byId.get(item.id);
              if (!svc) return null;
              return (
                <SortableTile key={item.id} id={item.id}>
                  {({ setNodeRef, style, handleProps }) => (
                    <div ref={setNodeRef} style={style} {...handleProps} className="rail-slot">
                      {renderService(svc)}
                    </div>
                  )}
                </SortableTile>
              );
            }

            const members = item.serviceIds
              .map((id) => byId.get(id))
              .filter((s): s is ServiceView => Boolean(s));

            return (
              <SortableTile key={item.id} id={item.id}>
                {({ setNodeRef, style, handleProps }) => (
                  <div ref={setNodeRef} style={style} {...handleProps} className="rail-slot">
                    <FolderTile
                      folder={item}
                      members={members}
                      onToggle={() => send({ type: 'toggle-folder', folderId: item.id })}
                      onContextMenu={() => send({ type: 'show-folder-menu', folderId: item.id })}
                    />
                    {!item.collapsed && members.map((svc) => renderService(svc, true))}
                  </div>
                )}
              </SortableTile>
            );
          })}
        </nav>
      </SortableRailList>

      <div className="rail-footer">
        <button
          className="rail-item rail-add"
          title="Add a connection (⌘N)"
          aria-label="Add a connection"
          onClick={() => send({ type: 'open-connections' })}
        >
          <span className="rail-plus">+</span>
        </button>
        {/* ⌘, works but is undiscoverable — the gear is how most people will find Settings. */}
        <button
          className="rail-item rail-add rail-settings"
          title="Settings (⌘,)"
          aria-label="Settings"
          onClick={() => send({ type: 'open-settings' })}
        >
          <span className="rail-gear">⚙</span>
        </button>
      </div>
    </div>
  );
}
