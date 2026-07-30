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
  onToggle,
  onContextMenu,
}: {
  folder: Extract<RailItem, { kind: 'folder' }>;
  members: ServiceView[];
  onToggle: () => void;
  onContextMenu: () => void;
}) {
  const unread = members.reduce((sum, m) => sum + m.unread, 0);

  return (
    <button
      className={`rail-item rail-folder${folder.collapsed ? '' : ' is-open'}`}
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
      {unread > 0 && <span className="rail-badge">{unread}</span>}
    </button>
  );
}
