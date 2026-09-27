import { randomUUID } from 'node:crypto';
import { detach, flattenServiceIds } from '@core/workspace/folders';
import type { Config, RailItem, Workspace } from '@shared/types';

/**
 * Workspace lifecycle. Pure over `Config`, so the awkward cases are testable.
 *
 * The awkward case is deletion. Services live in one global list; a workspace only *references*
 * them. Delete a workspace and any service referenced by nothing else becomes unreachable — still
 * in config, still holding a session, invisible in every rail. Silent data loss with extra steps.
 *
 * So deletion **rehomes orphans** rather than dropping them. Removing a grouping should never
 * remove the things grouped, which is the same reasoning as ungrouping a folder.
 */

export function createWorkspace(config: Config, name: string): string {
  const id = randomUUID();
  config.workspaces.push({ id, name: name.trim() || 'Workspace', items: [] });
  return id;
}

export function renameWorkspace(config: Config, workspaceId: string, name: string): void {
  const workspace = config.workspaces.find((w) => w.id === workspaceId);
  if (workspace && name.trim()) workspace.name = name.trim();
}

export interface DeleteResult {
  deleted: boolean;
  /** Services rehomed because nothing else referenced them. */
  rehomed: string[];
  /** The workspace now active, if deletion changed it. */
  activeWorkspaceId: string | null;
}

export function deleteWorkspace(config: Config, workspaceId: string): DeleteResult {
  const index = config.workspaces.findIndex((w) => w.id === workspaceId);
  // Refuse to remove the last one: an app with no workspaces has nowhere to put anything.
  if (index === -1 || config.workspaces.length <= 1) {
    return { deleted: false, rehomed: [], activeWorkspaceId: config.activeWorkspaceId };
  }

  const [removed] = config.workspaces.splice(index, 1) as [Workspace];
  // Layouts are keyed by workspace id and nothing else references them, so leaving this behind
  // grows config forever — and a workspace later created with the same id would inherit a stale
  // pane arrangement.
  delete config.layouts[workspaceId];
  const survivors = new Set(config.workspaces.flatMap(flattenServiceIds));
  const orphans = flattenServiceIds(removed).filter((id) => !survivors.has(id));

  const fallback = config.workspaces[0]!;
  fallback.items.push(...orphans.map((id): RailItem => ({ kind: 'service', id })));

  if (config.activeWorkspaceId === workspaceId) {
    config.activeWorkspaceId = fallback.id;
  }

  return { deleted: true, rehomed: orphans, activeWorkspaceId: config.activeWorkspaceId };
}

/** Ids the caller didn't know about are appended rather than dropped. */
export function reorderWorkspaces(config: Config, ids: string[]): void {
  const byId = new Map(config.workspaces.map((w) => [w.id, w]));
  const ordered = ids.map((id) => byId.get(id)).filter((w): w is Workspace => Boolean(w));
  const seen = new Set(ordered.map((w) => w.id));
  config.workspaces = [...ordered, ...config.workspaces.filter((w) => !seen.has(w.id))];
}

/**
 * A service can legitimately appear in several workspaces, but must never be absent from all of
 * them — that's the unreachable state. Called after any structural change as a safety net.
 */
export function rehomeUnreachable(config: Config): string[] {
  const reachable = new Set(config.workspaces.flatMap(flattenServiceIds));
  const orphans = config.services.filter((s) => !reachable.has(s.id)).map((s) => s.id);
  const target = config.workspaces[0];
  if (target && orphans.length) {
    target.items.push(...orphans.map((id): RailItem => ({ kind: 'service', id })));
  }
  return orphans;
}

/**
 * The workspace a service lives in, preferring the active one when it is in several.
 *
 * For anything that can name a service from outside the rail — the tray, the palette, a
 * notification — and so has to be able to reach one in a workspace you are not looking at.
 */
export function workspaceHolding(config: Config, serviceId: string): string | null {
  const holds = (w: Config['workspaces'][number]) => flattenServiceIds(w).includes(serviceId);
  const active = config.workspaces.find((w) => w.id === config.activeWorkspaceId);
  if (active && holds(active)) return active.id;
  return config.workspaces.find(holds)?.id ?? null;
}

/**
 * Moves a service to another workspace: out of every other one it is in — folders included — and
 * onto the end of the target's rail. False when the target doesn't exist, in which case nothing is
 * touched: a service must never be left in no workspace at all.
 */
export function moveServiceToWorkspace(config: Config, serviceId: string, targetId: string): boolean {
  const target = config.workspaces.find((w) => w.id === targetId);
  if (!target) return false;
  for (const w of config.workspaces) if (w.id !== targetId) detach(w, serviceId);
  if (!flattenServiceIds(target).includes(serviceId)) target.items.push({ kind: 'service', id: serviceId });
  return true;
}
