import { randomUUID } from 'node:crypto';
import type { RailItem, Workspace } from '../shared/types';

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
function detach(workspace: Workspace, serviceId: string): void {
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

/** Reorders top-level items. Ids the renderer didn't know about are appended, never dropped. */
export function reorderItems(workspace: Workspace, itemIds: string[]): void {
  const byId = new Map(workspace.items.map((item) => [item.id, item]));
  const ordered = itemIds.map((id) => byId.get(id)).filter((i): i is RailItem => Boolean(i));
  const seen = new Set(ordered.map((i) => i.id));
  workspace.items = [...ordered, ...workspace.items.filter((i) => !seen.has(i.id))];
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
