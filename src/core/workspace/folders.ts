import { randomUUID } from 'node:crypto';
import type { RailItem, Workspace } from '@shared/types';

/**
 * Operations on a workspace's rail tree.
 *
 * Pure functions over `Workspace.items` — no Electron, so they're testable under plain node, which
 * matters because the invariants here are easy to break silently: a service must appear exactly
 * once in the tree, and folders never nest.
 */

/** Every service id in the tree, in the order the rail draws them. */
export function flattenServiceIds(workspace: Workspace): string[] {
  const out: string[] = [];
  for (const item of workspace.items) {
    if (item.kind === 'service') out.push(item.id);
    else out.push(...item.serviceIds);
  }
  return out;
}

export const findFolder = (workspace: Workspace, folderId: string) =>
  workspace.items.find((i): i is Extract<RailItem, { kind: 'folder' }> =>
    i.kind === 'folder' && i.id === folderId
  );

/** Strips a service from wherever it currently sits — top level or any folder. */
export function detach(workspace: Workspace, serviceId: string): void {
  workspace.items = workspace.items.filter(
    (item) => !(item.kind === 'service' && item.id === serviceId)
  );
  for (const item of workspace.items) {
    if (item.kind === 'folder') {
      item.serviceIds = item.serviceIds.filter((id) => id !== serviceId);
    }
  }
}

/**
 * Moves a service into a folder, or back to the top level when `folderId` is null. Detaching first
 * is what guarantees the "exactly once" invariant — without it a move would duplicate the tile.
 */
export function moveToFolder(workspace: Workspace, serviceId: string, folderId: string | null): void {
  const wasPresent =
    flattenServiceIds(workspace).includes(serviceId);
  if (!wasPresent) return;

  detach(workspace, serviceId);

  if (folderId === null) {
    workspace.items.push({ kind: 'service', id: serviceId });
    return;
  }

  const folder = findFolder(workspace, folderId);
  if (folder) folder.serviceIds.push(serviceId);
  // Unknown folder: the service would vanish, so put it back at the top level instead.
  else workspace.items.push({ kind: 'service', id: serviceId });
}

export function createFolder(workspace: Workspace, name: string, serviceIds: string[] = []): string {
  const id = randomUUID();
  for (const serviceId of serviceIds) detach(workspace, serviceId);
  workspace.items.push({ kind: 'folder', id, name, collapsed: false, serviceIds: [...serviceIds] });
  return id;
}

/** Deletes the folder but keeps its services, promoted to the top level in place. */
export function deleteFolder(workspace: Workspace, folderId: string): void {
  const index = workspace.items.findIndex((i) => i.kind === 'folder' && i.id === folderId);
  if (index === -1) return;
  const folder = workspace.items[index] as Extract<RailItem, { kind: 'folder' }>;
  workspace.items.splice(
    index,
    1,
    ...folder.serviceIds.map((id): RailItem => ({ kind: 'service', id }))
  );
}

/** Where an id currently sits in the tree. `null` for an id the tree has never heard of. */
type Spot =
  | { level: 'top'; index: number }
  | { level: 'folder'; folderId: string; index: number };

function spotOf(workspace: Workspace, id: string): Spot | null {
  const top = workspace.items.findIndex((item) => item.id === id);
  if (top !== -1) return { level: 'top', index: top };
  for (const item of workspace.items) {
    if (item.kind !== 'folder') continue;
    const index = item.serviceIds.indexOf(id);
    if (index !== -1) return { level: 'folder', folderId: item.id, index };
  }
  return null;
}

/**
 * Puts `activeId` where `overId` is — the one operation the rail's drag performs, for reordering
 * and for filing into a folder alike.
 *
 * **The destination is decided by what was dropped on, not by where that lands in the list.** The
 * rail draws folder members inline, so the flattened order is ambiguous in exactly one place: a
 * service between the last member of a folder and the next top-level tile could mean either, and a
 * column of 48px icons has nowhere to show an indent guide saying which. Reading the drop target
 * instead makes the gesture describable in one sentence — drop *on a folder* to file it there, drop
 * *on a tile* to sit beside it — with no ambiguity to resolve.
 *
 * Index semantics match dnd-kit's `arrayMove`, which is what the drag animation has already shown
 * the user: the target index is taken before the removal, so it is interpreted against the
 * already-shortened list.
 */
export function moveItemTo(workspace: Workspace, activeId: string, overId: string): void {
  if (activeId === overId) return;
  const from = spotOf(workspace, activeId);
  const to = spotOf(workspace, overId);
  if (!from || !to) return;

  const active = from.level === 'top' ? workspace.items[from.index] : undefined;

  // Folders never nest. Dropped anywhere, a folder lands at the top level — beside the *folder*
  // when the pointer was over one of its members, because that is where it can actually be seen.
  if (active?.kind === 'folder') {
    const index =
      to.level === 'top' ? to.index : workspace.items.findIndex((i) => i.id === to.folderId);
    if (index === -1) return;
    const [moved] = workspace.items.splice(from.index, 1);
    if (moved) workspace.items.splice(index, 0, moved);
    return;
  }

  const over = to.level === 'top' ? workspace.items[to.index] : undefined;
  const target: Spot =
    over?.kind === 'folder'
      ? // Onto a folder tile: file it there. Appending rather than inserting because a collapsed
        // folder shows no members to aim between, and this gesture has to mean the same thing
        // whether the folder is open or shut.
        { level: 'folder', folderId: over.id, index: over.serviceIds.length }
      : to;

  detach(workspace, activeId);

  if (target.level === 'top') {
    workspace.items.splice(Math.min(target.index, workspace.items.length), 0, {
      kind: 'service',
      id: activeId,
    });
    return;
  }

  const folder = findFolder(workspace, target.folderId);
  // The folder was deleted between the render and the drop. Top level, rather than nowhere.
  if (!folder) {
    workspace.items.push({ kind: 'service', id: activeId });
    return;
  }
  folder.serviceIds.splice(Math.min(target.index, folder.serviceIds.length), 0, activeId);
}

/** Drops references to services that no longer exist, from both levels. */
export function pruneMissing(workspace: Workspace, existing: Set<string>): void {
  workspace.items = workspace.items
    .map((item) =>
      item.kind === 'folder'
        ? { ...item, serviceIds: item.serviceIds.filter((id) => existing.has(id)) }
        : item
    )
    .filter((item) => item.kind === 'folder' || existing.has(item.id));
}

/** v3 → v4: a flat `serviceIds` array becomes top-level service items. */
export function migrateWorkspaceV3(raw: { id: string; name: string; serviceIds?: string[]; items?: RailItem[] }): Workspace {
  if (raw.items) return { id: raw.id, name: raw.name, items: raw.items };
  return {
    id: raw.id,
    name: raw.name,
    items: (raw.serviceIds ?? []).map((id): RailItem => ({ kind: 'service', id })),
  };
}
