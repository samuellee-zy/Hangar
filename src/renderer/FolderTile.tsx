import { badgeText } from './badge';
import type { RailItem, ServiceView } from '@shared/types';

/**
 * A folder in the rail: a 2×2 grid of its members' icons, with unread rolled up.
 *
 * Clicking expands it inline (accordion) rather than opening a flyout — in a 72px vertical rail an
 * accordion keeps everything on one axis, and a flyout would need the overlay layer just to escape
 * the rail's bounds.
 */
export function FolderTile({
  folder,
  members,
  labelled = false,
  onToggle,
  onContextMenu,
}: {
  folder: Extract<RailItem, { kind: 'folder' }>;
  members: ServiceView[];
  /** In an opened panel the name sits beside the grid, as a service's does beside its icon. */
  labelled?: boolean;
  onToggle: () => void;
  onContextMenu: () => void;
}) {
  const unread = members.reduce((sum, m) => sum + m.unread, 0);

  return (
    <button
      className={`rail-item rail-folder${folder.collapsed ? '' : ' is-open'}`}
      // `aria-expanded` works on a plain button and is the one piece of state a folder has that a
      // service doesn't — without it a collapsed folder is indistinguishable from an empty one.
      aria-expanded={!folder.collapsed}
      aria-label={[
        folder.name,
        `${members.length} service${members.length === 1 ? '' : 's'}`,
        unread > 0 ? `${unread} unread` : null,
      ]
        .filter(Boolean)
        .join(', ')}
      title={`${folder.name} — ${members.length} service${members.length === 1 ? '' : 's'}`}
      onClick={onToggle}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu();
      }}
    >
      <span className="folder-grid">
        {/* Four at most; a fuller folder just shows its first four. */}
        {members.slice(0, 4).map((m) => (
          <img key={m.id} className="folder-mini" src={`hangar-icon://${m.id}`} alt="" />
        ))}
        {members.length === 0 && <span className="folder-empty">·</span>}
      </span>
      {/* aria-hidden: the name is already the start of `aria-label`. */}
      {labelled && (
        <span className="rail-label" aria-hidden="true">
          {folder.name}
        </span>
      )}
      {unread > 0 && (
        <span className="rail-badge" aria-hidden="true">
          {badgeText(unread)}
        </span>
      )}
    </button>
  );
}
