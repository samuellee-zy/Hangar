import { loadConfig, updateConfig } from '@main/platform/config';
import { popOut } from '@main/features/popout';
import { workspaceHolding } from '@core/workspace/workspaces';
import { resolveUrl } from '@shared/catalog';
import type { CommandTable } from '@main/window/commands/context';

/** What is on screen: which service is in which pane, focus, zoom, find, and the pane's page. */
export const paneCommands: CommandTable = {
  'focus-service': (command, shell) => {
    // A service in another workspace — reachable now from the tray, the palette and a
    // notification — is opened in its own workspace, not dropped into this one's panes.
    const config = loadConfig();
    const home = workspaceHolding(config, command.serviceId);
    if (home && home !== config.activeWorkspaceId) {
      shell.dispatch({ type: 'set-workspace', workspaceId: home });
    }
    shell.overlay.close();
    shell.openService(command.serviceId);
    // Without this, clicking a service that's already the focused pane changes nothing on
    // screen and reads as a dead button — the reported bug.
    shell.flash(command.serviceId);
    // Into the page. Switching used to leave the keyboard wherever it was — in the palette that
    // had just closed, in the old pane now detached, in the rail — so the first keystrokes after
    // ⌘K↵ or ⌘3 went nowhere until you clicked the page.
    if (!command.keepFocus) shell.focusActivePane();
  },

  'open-in-new-pane': (command, shell) => {
    shell.overlay.close();
    shell.openService(command.serviceId, { newPane: true });
    if (!command.keepFocus) shell.focusActivePane();
  },

  split: (_command, shell) => {
    // Split with the next service in the workspace that isn't already on screen.
    const visible = shell.layout.visibleServiceIds();
    const next = shell.activeServices(loadConfig().activeWorkspaceId).find((s) => !visible.has(s.id));
    if (!next) return;
    shell.openService(next.id, { newPane: true });
    shell.focusActivePane();
  },

  'focus-pane': (command, shell) => {
    // Ignore a stale pane id rather than pointing focus at nothing.
    if (!shell.layout.find(command.paneId)) return;
    shell.layout.focusedPaneId = command.paneId;
    shell.focusActivePane();
    shell.saveLayout();
    shell.sync();
  },

  'cycle-pane': (command, shell) => {
    shell.layout.cycleFocus(command.delta);
    shell.focusActivePane();
    shell.saveLayout();
    shell.sync();
  },

  'close-pane': (command, shell) => {
    // Closing the last pane means closing the window — otherwise ⌘W is a no-op and the window
    // can't be dismissed from the keyboard at all.
    if (shell.layout.panes.length === 1) {
      shell.win.close();
      return;
    }
    shell.layout.close(command.paneId);
    shell.relayout();
    shell.saveLayout();
  },

  'toggle-maximise-pane': (_command, shell) => {
    shell.layout.toggleMaximise();
    shell.relayout();
    shell.focusActivePane();
  },

  navigate: (command, shell) => {
    const pane = shell.layout.focused();
    if (pane) shell.services.navigate(pane.serviceId, command.direction);
  },

  zoom: (command, shell) => {
    const pane = shell.layout.focused();
    const svc = pane && loadConfig().services.find((s) => s.id === pane.serviceId);
    const runtime = pane && shell.services.get(pane.serviceId);
    if (!svc || !runtime) return;
    const base = svc.zoom || 1;
    const next =
      command.direction === 'reset'
        ? loadConfig().preferences.behaviour.defaultZoom
        : Math.min(2, Math.max(0.5, Number((base + (command.direction === 'in' ? 0.1 : -0.1)).toFixed(2))));
    runtime.view.webContents.setZoomFactor(next);
    // Persisted per service, so it survives a reload and a restart.
    updateConfig((c) => {
      const target = c.services.find((s) => s.id === svc.id);
      if (target) target.zoom = next;
    });
    shell.sync();
  },

  print: (_command, shell) => {
    const pane = shell.layout.focused();
    shell.services.get(pane?.serviceId ?? '')?.view.webContents.print();
  },

  'reload-service': (command, shell) => {
    const runtime = shell.services.get(command.serviceId);
    if (!runtime || runtime.view.webContents.isDestroyed()) return;
    if (command.ignoreCache) runtime.view.webContents.reloadIgnoringCache();
    else runtime.view.webContents.reload();
  },

  'sleep-service': (command, shell) => {
    shell.sleep(command.serviceId);
    shell.relayout();
  },

  'sleep-others': (_command, shell) => {
    const keep = shell.layout.visibleServiceIds();
    // Nor the ones set to keep running — that setting exists so they don't go quiet off screen.
    // Each can still be put to sleep on its own, from its tile's menu.
    for (const svc of loadConfig().services) if (svc.keepRunning) keep.add(svc.id);
    for (const [serviceId] of [...shell.services.all()]) {
      if (!keep.has(serviceId)) shell.sleep(serviceId);
    }
    shell.relayout();
  },

  'pop-out-service': (command, shell) => {
    const svc = loadConfig().services.find((s) => s.id === command.serviceId);
    if (!svc) return;
    // The page on screen, not the start page — popping out a call must not restart it.
    const url = shell.contentsForService(svc.id)?.getURL() || resolveUrl(svc);
    // And only one copy: two of the same call, or of the same chat, is two sets of everything.
    if (shell.services.has(svc.id)) shell.dispatch({ type: 'sleep-service', serviceId: svc.id });
    popOut(svc, url);
  },

  'open-find': (_command, shell) => {
    const pane = shell.layout.focused();
    const wc = pane && shell.services.get(pane.serviceId)?.view.webContents;
    const rect = pane ? shell.paneRect(pane.id) : null;
    if (wc && rect && pane) shell.findBar.open(wc, rect, pane.serviceId);
  },

  'close-find': (_command, shell) => {
    shell.findBar.close();
    shell.focusActivePane();
  },

  find: (command, shell) => {
    shell.findBar.search(command.query, {
      forward: command.forward ?? true,
      findNext: command.findNext ?? false,
    });
  },
};
