import { useEffect, useRef, useState } from 'react';
import { brightenForDark } from './accent';
import { badgeText } from './badge';
import { withChord } from './chords';
import { CommitOnBlur } from './CommitOnBlur';
import { FolderTile } from './FolderTile';
import { ServiceIcon } from './ServiceIcon';
import { SortableRailList, SortableTile } from './SortableRail';
import { useShellState } from './useShellState';
import type { RailItem, ServiceView } from '@shared/types';

/**
 * The icon rail. Renders `ShellState.railItems` — an ordered tree of top-level services and
 * folders — and holds no state of its own.
 *
 * One drag gesture does three things, all of them decided elsewhere: reorder the top level, file a
 * service into a folder or take it back out (`moveItemTo`), and drop a tile onto a pane
 * (`SortableRail.tsx`, and `main/features/drag-layer.ts` for why a pane can't simply be a drop
 * target). The right-click `Move to folder ▸` stays for keyboard and precision use.
 *
 * The hover reported here is the other thing this surface knows and main doesn't. It is *reported*
 * rather than acted on: whether a compact rail may open right now is main's to decide, and comes
 * back as `railExpanded`.
 */
/** Points the way the rail will move: outward to open, back toward its edge to close. */
function chevronGlyph(position: string, collapsed: boolean): string {
  const open = { left: '›', right: '‹', top: '⌄', bottom: '⌃' }[position] ?? '›';
  const shut = { left: '‹', right: '›', top: '⌃', bottom: '⌄' }[position] ?? '‹';
  return collapsed ? open : shut;
}

export function Rail() {
  const state = useShellState();
  // Which row is being renamed in place, if any. Renderer-local on purpose: an abandoned edit is
  // not worth a round trip to main, and main has nothing to decide about it.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Right-click ▸ Rename… arrives here, from main. Keyed on the nonce and not the id: every other
  // state broadcast carries the same request along with it, and reacting to those would reopen an
  // edit the moment you finished one.
  //
  // `null` until the first state arrives, which is adopted as already handled. Main never clears a
  // request, so a rail that reloads — after a crash, now that it recovers from one — would otherwise
  // find the last one waiting and reopen an edit nobody asked for. Initialising from state at mount
  // could not catch that: state is always null on the first render.
  const actedOnNonce = useRef<number | null>(null);
  const request = state?.renameRequest;
  const appearance = state?.preferences.appearance;
  const hasState = state !== null;
  useEffect(() => {
    if (!hasState) return;
    if (actedOnNonce.current === null) {
      actedOnNonce.current = request?.nonce ?? 0;
      return;
    }
    if (!request?.id || !appearance || request.nonce === actedOnNonce.current) return;
    actedOnNonce.current = request.nonce;
    // Only a vertical compact rail has a panel to put the field in. An ordinary 72px rail has no
    // room for a text field and a horizontal one has no room for a name at all, so those send you
    // to Settings — which lists both services and folders — rather than dropping the request.
    const horizontal = appearance.railPosition === 'top' || appearance.railPosition === 'bottom';
    if (appearance.compactRail && !horizontal) setRenamingId(request.id);
    else window.hangar.send({ type: 'open-settings' });
  }, [hasState, request, appearance]);

  if (!state) return null;

  const visible = new Set(state.panes.map((p) => p.serviceId));
  const focusedServiceId = state.panes.find((p) => p.id === state.focusedPaneId)?.serviceId;
  const { railPosition, showLabels, density, compactRail } = state.preferences.appearance;
  // Collapsed, a compact rail is the icons and nothing else — every service still one click away.
  const compact = compactRail && !state.railExpanded;
  // Top and bottom lay the rail out as a row; the tile treatment is otherwise identical.
  const horizontal = railPosition === 'top' || railPosition === 'bottom';
  // Opened, a vertical compact rail becomes a panel: icon and name on one row. Labels are not
  // optional here the way `showLabels` is on an ordinary rail — the name is the entire difference
  // between the two states, and an opened panel of unlabelled icons would just be a wider strip.
  const panel = compactRail && state.railExpanded && !horizontal;
  const labelled = panel || (showLabels && !compact && !horizontal);
  const byId = new Map(state.services.map((s) => [s.id, s]));
  // ⌘1–9 follow the flattened visual order, which is what `services` is.
  const position = new Map(state.services.slice(0, 9).map((s, i) => [s.id, i + 1]));
  // Every workspace, like the Dock badge: a message in another workspace is still one to hear about.
  const totalUnread = state.allServices.reduce((sum, s) => sum + s.unread, 0);
  const send = window.hangar.send;

  // Every draggable row in visual order, open folders' members included. One flat list because
  // dnd-kit only matches a drag to a drop target within a single `SortableContext`, and dragging a
  // service *out* of a folder has to be able to land on a top-level tile.
  const members = (item: RailItem) =>
    item.kind === 'folder' && !item.collapsed ? item.serviceIds.filter((id) => byId.has(id)) : [];
  const rows = state.railItems.flatMap((item) => [item.id, ...members(item)]);

  const renderService = (svc: ServiceView, nested = false) => {
    // Keyed here rather than at each call site: this returns a fragment, and mapping it over a
    // folder's members produced a keyless list — React then reconciles by index, so collapsing a
    // folder or reordering its members could carry one tile's DOM state onto another.
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

    // `panel &&` so a rail collapsed mid-edit falls back to its icon rather than trying to fit a
    // text field into a 48px strip.
    if (panel && renamingId === svc.id) {
      return (
        <div className="rail-row" key={svc.id}>
          {/*
            The input replaces the tile rather than sitting inside it — a text field is not
            permitted content for a <button>, and nesting one is what makes a row stop responding
            to clicks in ways that are miserable to track down.

            `stopPropagation` on keydown is load-bearing: the row is a dnd-kit draggable, whose
            keyboard sensor treats Space and Enter on a focused draggable as "lift this". Without
            it, typing a space into the name starts a drag.
          */}
          <div
            className="rail-rename"
            style={{ ['--accent' as string]: brightenForDark(svc.color) }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setRenamingId(null);
            }}
            // React's onBlur is focusout, which bubbles — so this catches the field losing focus
            // whether the edit was committed or clicked away from.
            onBlur={() => setRenamingId(null)}
          >
            <ServiceIcon serviceId={svc.id} initials={svc.initials} name={svc.name} />
            <CommitOnBlur
              className="rail-rename-field"
              autoFocus
              aria-label={`Rename ${svc.name}`}
              value={svc.name}
              onCommit={(name) => send({ type: 'rename-service', serviceId: svc.id, name })}
            />
          </div>
        </div>
      );
    }

    return (
      // A row rather than a fragment: opened, the label sits beside the icon rather than under it,
      // and the two need a box of their own to be laid out in.
      <div className="rail-row" key={svc.id}>
        <button
          className={classes}
          // Two services from the same catalog entry arrive with the same name — two tiles both
          // called "Teams" — and the panel is the only place the name is on screen to correct.
          onDoubleClick={() => {
            if (panel) setRenamingId(svc.id);
          }}
          // Deliberately left as a native <button>, NOT role="treeitem".
          //
          // A tree promises arrow-key navigation with a roving tabindex, and we don't implement
          // that — dnd-kit already owns the arrows for moving a lifted tile. Announcing "tree, use
          // arrows" to a screen-reader user and then ignoring the arrows is worse than a plain run
          // of buttons that Tab through correctly. Structure is conveyed by the labelled group
          // around folder members instead.
          aria-current={svc.id === focusedServiceId ? 'true' : undefined}
          // The tooltip is not an accessible name — `title` is announced inconsistently and only
          // after a delay. State that matters (asleep, unread) belongs in the name itself.
          //
          // The service name stays FIRST. `e2e/app.spec.ts` selects tiles with
          // `[aria-label*="One"]`, so appending to this is safe and reordering is not.
          //
          // "click to wake" because "asleep" alone reads as a status, not an invitation — a
          // hibernated tile looks disabled, and nothing said that clicking it brings it back.
          aria-label={[
            svc.name,
            svc.sleeping ? 'asleep, click to wake' : null,
            svc.unread > 0 ? `${svc.unread} unread` : null,
          ]
            .filter(Boolean)
            .join(', ')}
          // Identity lives in the accent and the icon; the tile surface carries state only.
          style={{ ['--accent' as string]: brightenForDark(svc.color) }}
          title={[
            svc.sleeping
              ? `${svc.name} — asleep, click to wake`
              : svc.loading
                ? `${svc.name} — loading…`
                : // In a panel the name is already on screen, so repeating it in a tooltip says
                  // nothing. The one thing not discoverable there is that it can be edited.
                  panel
                  ? `${svc.name} — double-click to rename`
                  : svc.name,
            // The two ways to reach a tile that nothing on screen mentions.
            position.has(svc.id) ? `⌘${position.get(svc.id)}` : null,
            '⌥-click to open beside',
          ]
            .filter(Boolean)
            .join(' · ')}
          onContextMenu={(e) => {
            e.preventDefault();
            send({ type: 'show-service-menu', serviceId: svc.id });
          }}
          onClick={(e) =>
            send(
              // ⌥-click opens alongside rather than replacing — the mouse equivalent of ⌘\.
              e.altKey
                ? { type: 'open-in-new-pane', serviceId: svc.id }
                : { type: 'focus-service', serviceId: svc.id },
            )
          }
        >
          <ServiceIcon serviceId={svc.id} initials={svc.initials} name={svc.name} />
          {/* In a panel the name goes INSIDE the button, so the whole row is the target — the way
              a Chrome tab is clickable across its width. Beside the button it looked clickable and
              was not, which is a worse affordance than no label at all.

              aria-hidden: `aria-label` above is already the accessible name, and a visible name
              inside the button would otherwise be concatenated into a stutter. */}
          {panel && (
            <span className="rail-label" aria-hidden="true">
              {svc.name}
            </span>
          )}
          {/* aria-hidden: the count is already in the tile's accessible name, and announcing it
              twice is worse than once. The live region below handles the *change*. */}
          {svc.unread > 0 && (
            <span className="rail-badge" aria-hidden="true">
              {badgeText(svc.unread)}
            </span>
          )}
        </button>
        {labelled && !panel && <span className="rail-label">{svc.name}</span>}
      </div>
    );
  };

  return (
    <div
      className={[
        'rail',
        `is-${railPosition}`,
        horizontal ? 'is-horizontal' : 'is-vertical',
        `is-${density}`,
        compact ? 'is-compact' : '',
        panel ? 'is-panel' : '',
        state.railExpanded ? 'is-expanded' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      // No width here: the rail element fills its view, and main resizes the view. Setting it from
      // state as well would mean the box and the window it lives in disagree for a frame on every
      // expand — a stripe of pane showing through the rail, or the rail clipped mid-tile.
      onContextMenu={(e) => {
        e.preventDefault();
        send({ type: 'show-rail-menu' });
      }}
      // An opened panel is mostly empty space — six services in a full-height column — and that
      // space did nothing at all. Clicking it shuts the panel, which is the only thing it could
      // sensibly mean: it is the "outside" of the list, and dismissing on outside-click is what
      // every other transient panel does.
      //
      // Only when open, and only on the background: `closest('button')` lets every tile, the
      // footer and the chevron handle their own clicks first.
    >
      {/* Clear of the traffic lights, and the window's drag handle. A compact rail never holds the
          traffic lights — `chromeFor` puts them in the top strip whichever way it is sized — so
          there is nothing to clear and the strip would only be dead space. */}
      <div className="rail-drag" hidden={compactRail} />

      {/* The tiles are drawn in both states. Only the labels come and go. */}
      <SortableRailList
        ids={rows}
        horizontal={horizontal}
        nameOf={(id) => {
          if (byId.has(id)) return byId.get(id)!.name;
          const folder = state.railItems.find((item) => item.id === id);
          return folder?.kind === 'folder' ? `folder ${folder.name}` : 'item';
        }}
        onMove={({ activeId, overId }) => send({ type: 'move-item', activeId, overId })}
        canDropOnPane={(id) => byId.has(id)}
      >
        <nav className="rail-items" aria-label="Services">
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

            const folderMembers = item.serviceIds
              .map((id) => byId.get(id))
              .filter((s): s is ServiceView => Boolean(s));

            return (
              <SortableTile key={item.id} id={item.id}>
                {({ setNodeRef, style, handleProps }) => (
                  <div ref={setNodeRef} style={style} {...handleProps} className="rail-slot">
                    {panel && renamingId === item.id ? (
                      // Same shape and the same two hazards as a service's rename above: the field
                      // replaces the button, and keydown must not reach the draggable.
                      <div className="rail-row">
                        <div
                          className="rail-rename"
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          onBlur={() => setRenamingId(null)}
                        >
                          <span className="rail-rename-folder" aria-hidden="true">
                            ▦
                          </span>
                          <CommitOnBlur
                            className="rail-rename-field"
                            autoFocus
                            aria-label={`Rename folder ${item.name}`}
                            value={item.name}
                            onCommit={(name) =>
                              send({ type: 'rename-folder', folderId: item.id, name })
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <FolderTile
                        folder={item}
                        members={folderMembers}
                        labelled={panel}
                        onToggle={() => send({ type: 'toggle-folder', folderId: item.id })}
                        onContextMenu={() => send({ type: 'show-folder-menu', folderId: item.id })}
                      />
                    )}
                    {!item.collapsed && (
                      // `group` is what makes the members read as *inside* the folder rather
                      // than as siblings that happen to follow it.
                      <div role="group" aria-label={item.name}>
                        {folderMembers.map((svc) => (
                          <SortableTile key={svc.id} id={svc.id}>
                            {({
                              setNodeRef: ref,
                              style: memberStyle,
                              handleProps: memberProps,
                            }) => (
                              <div
                                ref={ref}
                                style={memberStyle}
                                {...memberProps}
                                className="rail-slot is-member"
                              >
                                {renderService(svc, true)}
                              </div>
                            )}
                          </SortableTile>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </SortableTile>
            );
          })}
        </nav>
      </SortableRailList>

      {/*
        One polite live region for the whole rail rather than aria-live on each badge. Per-badge
        would announce every service's count on any change, and `polite` waits for a pause instead
        of interrupting — a message arriving should not cut across what you're reading.

        Kept outside the collapse: a hidden rail still counts, and unread is the one thing you need
        to hear about while it is away.
      */}
      <span className="visually-hidden" role="status" aria-live="polite">
        {totalUnread > 0 ? `${totalUnread} unread` : ''}
      </span>

      {/*
        Bottom-anchored in both states, so nothing in it moves when the rail opens. Add and Settings
        stay visible collapsed — they are one-click affordances for the two things the rail cannot
        otherwise reach, and Chrome keeps its new-tab button in the collapsed strip for the same
        reason. The chevron is last: it is the control that changes the shape of everything above it.
      */}
      <div className="rail-footer">
        <button
          className="rail-item rail-add"
          title={withChord(state, 'Add a connection', 'add-connection')}
          aria-label="Add a connection"
          onClick={() => send({ type: 'open-connections' })}
        >
          <span className="rail-plus">+</span>
          {/* aria-hidden: `aria-label` above is the accessible name; a visible one inside the
              button as well would be read as a stutter. */}
          {panel && (
            <span className="rail-label" aria-hidden="true">
              Add a connection
            </span>
          )}
        </button>
        {/* ⌘, works but is undiscoverable — the gear is how most people will find Settings. */}
        <button
          className="rail-item rail-add rail-settings"
          title={withChord(state, 'Settings', 'settings')}
          aria-label="Settings"
          onClick={() => send({ type: 'open-settings' })}
        >
          <span className="rail-gear">⚙</span>
          {panel && (
            <span className="rail-label" aria-hidden="true">
              Settings
            </span>
          )}
        </button>
        {compactRail && (
          <button
            className="rail-chevron"
            title={compact ? 'Show the rail' : 'Hide the rail'}
            aria-label={compact ? 'Show the rail' : 'Hide the rail'}
            aria-expanded={!compact}
            onClick={() => send({ type: 'toggle-rail' })}
          >
            <span className="rail-chevron-glyph" aria-hidden="true">
              {chevronGlyph(railPosition, compact)}
            </span>
            {panel && <span className="rail-chevron-text">Collapse</span>}
          </button>
        )}
      </div>
    </div>
  );
}
