import {
  addService,
  loadConfig,
  makeCustomInstance,
  makeInstance,
  updateConfig,
  updateConfigReturning,
} from '@main/platform/config';
import { normalisePassthrough } from '@core/keyboard/keymap';
import { isWebUrl } from '@core/runtime/urls';
import { sanitiseServicePatch } from '@core/services/patch';
import { moveServiceToWorkspace } from '@core/workspace/workspaces';
import type { CommandTable } from '@main/window/commands/context';

/** Adding, changing and removing services and accounts, and their unread and mute state. */
export const serviceCommands: CommandTable = {
  'add-service': (command, shell) => {
    const svc = updateConfigReturning((c) =>
      addService(c, makeInstance(c, command.catalogId, { forceNewAccount: command.forceNewAccount })),
    );
    shell.overlay.close();
    shell.openService(svc.id, { newPane: false });
    shell.flash(svc.id);
    shell.focusActivePane();
  },

  'add-custom-service': (command, shell) => {
    if (!isWebUrl(command.url)) {
      console.warn(`[command] add-custom-service refused: not an http(s) URL`);
      return;
    }
    const svc = updateConfigReturning((c) => addService(c, makeCustomInstance(c, command)));
    shell.overlay.close();
    shell.openService(svc.id, { newPane: false });
    shell.flash(svc.id);
    shell.focusActivePane();
  },

  'update-service': (command, shell) => {
    // Validated rather than assigned straight through: this was a bare `Object.assign`, so any
    // field and any value reached config verbatim. See `sanitiseServicePatch`.
    const patch = sanitiseServicePatch(command.patch);
    updateConfig((c) => {
      const svc = c.services.find((s) => s.id === command.serviceId);
      if (!svc) return;
      Object.assign(svc, patch);
      // A mute or unmute set by hand — Settings' checkbox, "Until I unmute it" — ends any timed
      // one. Otherwise a timer left from an earlier "for 1 hour" would lift a mute that is now
      // meant to be indefinite.
      if ('notificationLevel' in patch && !('mutedUntil' in patch)) delete svc.mutedUntil;
      // Canonicalised on the way in — Settings sends what it captured, and a list holding
      // `Meta+K` and `meta+k` would claim one chord twice and match neither reliably. Only
      // when the patch actually carries it, so every other update leaves it alone.
      if ('keyboardPassthrough' in patch) {
        svc.keyboardPassthrough = normalisePassthrough(patch.keyboardPassthrough);
      }
    });
    // Zoom applies live; CSS/JS and UA need a reload to take effect, so say so rather than
    // silently doing half the job.
    const runtime = shell.services.get(command.serviceId);
    const zoom = patch.zoom;
    if (runtime && typeof zoom === 'number') runtime.view.webContents.setZoomFactor(zoom);
    // The user agent too, for the next load: set on the page, and cleared back to the session's
    // default rather than left at the old value until the service was next woken from sleep.
    if (runtime && 'userAgent' in patch) {
      const wc = runtime.view.webContents;
      wc.setUserAgent(patch.userAgent || wc.session.getUserAgent());
    }
    // Unread detection applies live too, and has to: the field is edited by someone looking at
    // the page, and a selector you must reload to test is a selector nobody tunes. Muting also
    // lands here, which is how it stops the page watching for a count it isn't allowed to set.
    if ('unreadSelector' in patch || 'notificationLevel' in patch || 'notifications' in patch) {
      // The old count came from the old rules, so it is now unattributable. Detection reports
      // again within a frame or two if there is still something to report.
      shell.clearUnread(command.serviceId);
      shell.pushUnreadRules(command.serviceId);
    }
    shell.sync();
  },

  'rename-service': (command, shell) => {
    updateConfig((c) => {
      const svc = c.services.find((s) => s.id === command.serviceId);
      if (svc) svc.name = command.name;
    });
    shell.sync();
  },

  'begin-rename-service': (command, shell) => shell.beginRename(command.serviceId),
  'begin-rename-folder': (command, shell) => shell.beginRename(command.folderId),

  'remove-service': (command, shell) => shell.removeService(command.serviceId),

  'mute-service': (command, shell) => {
    updateConfig((c) => {
      const svc = c.services.find((s) => s.id === command.serviceId);
      if (!svc) return;
      if (command.until === null) {
        svc.notificationLevel = 'all';
        delete svc.mutedUntil;
      } else {
        svc.notificationLevel = 'muted';
        svc.mutedUntil = command.until;
      }
    });
    // Same as muting from Settings: the page is told to stop (or start) watching for a count.
    shell.clearUnread(command.serviceId);
    shell.pushUnreadRules(command.serviceId);
    shell.sync();
  },

  'mark-read': (command, shell) => {
    shell.clearUnread(command.serviceId);
    shell.sync();
  },

  'clear-unread': (command, shell) => {
    shell.clearUnread(command.serviceId);
    shell.sync();
  },

  'move-to-workspace': (command, shell) => {
    const moved = updateConfigReturning((c) =>
      moveServiceToWorkspace(c, command.serviceId, command.workspaceId),
    );
    if (!moved) return;
    // Gone from this workspace, so gone from its panes too — a pane showing a service the rail
    // no longer lists is exactly the stranded state `rehomeUnreachable` exists to prevent.
    if (loadConfig().activeWorkspaceId !== command.workspaceId) {
      for (const pane of shell.layout.panes.filter((p) => p.serviceId === command.serviceId)) {
        shell.layout.close(pane.id);
      }
      shell.saveLayout();
      shell.relayout();
    }
    shell.sync();
  },

  'rename-account': (command, shell) => {
    updateConfig((c) => {
      const account = c.accounts.find((a) => a.id === command.accountId);
      if (account) account.label = command.label;
    });
    shell.sync();
  },

  'sign-out-account': (command, shell) => {
    shell.signOut(command.accountId).catch((err: unknown) =>
      console.error(`[account] sign out of ${command.accountId} failed:`, err),
    );
  },
};
