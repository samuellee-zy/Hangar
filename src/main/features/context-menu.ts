import { Menu, app, clipboard, dialog, type BaseWindow, type WebContents } from 'electron';
import { catalogById } from '@shared/catalog';
import { HOUR_MS, tomorrowMorning } from '@core/notify/policy';
import { untilLabel } from '@main/features/tray';
import { openExternalSafely } from '@main/platform/external';
import type { Command, ServiceInstance } from '@shared/types';

/**
 * Native menus rather than React ones. `Menu.popup()` gets correct macOS styling and keyboard
 * navigation for free, and — the reason it actually matters — it can render outside the bounds of
 * the view that triggered it. A React menu inside the 72px rail would be clipped.
 *
 * Electron ships no context menu at all by default, so before this right-clicking anywhere in
 * Hangar did nothing: no copy, no paste, no spelling suggestions, no open-link-in-browser.
 */

type Dispatch = (command: Command) => boolean;

/** Popped at the cursor when x/y are omitted, so the caller needn't chase coordinates. */
const popup = (template: Electron.MenuItemConstructorOptions[], window: BaseWindow) =>
  Menu.buildFromTemplate(template).popup({ window });

// --- web views ---------------------------------------------------------------------------------

/**
 * Attached to every service view. Everything is derived from the `context-menu` params, so the menu
 * reflects what was actually right-clicked rather than a fixed list.
 *
 * Spelling suggestions require `webPreferences.spellcheck: true` — without it Chromium never
 * populates `dictionarySuggestions` and the section is silently always empty.
 */
export function installWebContextMenu(wc: WebContents, window: BaseWindow): void {
  wc.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    const { editFlags } = params;

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        // replaceMisspelling, not insertText — insertText has a history of crashing here.
        items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
      }
      if (params.dictionarySuggestions.length === 0) {
        items.push({ label: 'No suggestions', enabled: false });
      }
      items.push(
        { type: 'separator' },
        {
          label: 'Add to dictionary',
          click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: 'separator' },
      );
    }

    if (params.linkURL) {
      items.push(
        { label: 'Open link in browser', click: () => openExternalSafely(params.linkURL, 'context menu') },
        { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }

    if (params.hasImageContents) {
      items.push(
        { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Save image…', click: () => wc.downloadURL(params.srcURL) },
        { type: 'separator' },
      );
    }

    // Gated on editFlags so Paste isn't offered outside an editable field.
    if (params.isEditable || params.selectionText) {
      items.push(
        { label: 'Cut', role: 'cut', enabled: editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: editFlags.canPaste },
        { label: 'Select all', role: 'selectAll', enabled: editFlags.canSelectAll },
        { type: 'separator' },
      );
    }

    const nav = wc.navigationHistory;
    items.push(
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Copy current URL', click: () => clipboard.writeText(wc.getURL()) },
      { label: 'Open page in browser', click: () => openExternalSafely(wc.getURL(), 'context menu') },
    );

    // `app.isPackaged`, not an npm env var. The old check was
    // `!process.env['npm_lifecycle_event']?.includes('start')`, which is `!undefined` — i.e. TRUE —
    // in a packaged app, so "Inspect element" shipped to production and was hidden during
    // `npm start`, exactly backwards.
    if (!app.isPackaged) {
      items.push(
        { type: 'separator' },
        { label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) },
      );
    }

    popup(items, window);
  });
}

// --- rail --------------------------------------------------------------------------------------

export function showServiceMenu(
  window: BaseWindow,
  svc: ServiceInstance,
  {
    paneId,
    isSleeping,
    folders,
    currentFolderId,
    unread,
    currentUrl,
    otherWorkspaces,
  }: {
    /** The pane showing this service, or null when it isn't on screen. */
    paneId: string | null;
    isSleeping: boolean;
    folders: Array<{ id: string; name: string }>;
    currentFolderId: string | null;
    unread: number;
    currentUrl: string;
    otherWorkspaces: Array<{ id: string; name: string }>;
  },
  dispatch: Dispatch,
): void {
  const entry = catalogById(svc.catalogId);

  const moveTo: Electron.MenuItemConstructorOptions = {
    label: 'Move to folder',
    submenu: [
      {
        label: 'Top level',
        type: 'radio',
        checked: currentFolderId === null,
        click: () => dispatch({ type: 'move-to-folder', serviceId: svc.id, folderId: null }),
      },
      ...(folders.length ? [{ type: 'separator' as const }] : []),
      ...folders.map((f) => ({
        label: f.name,
        type: 'radio' as const,
        checked: f.id === currentFolderId,
        click: () => dispatch({ type: 'move-to-folder', serviceId: svc.id, folderId: f.id }),
      })),
      { type: 'separator' },
      {
        label: 'New folder with this service…',
        click: () => dispatch({ type: 'create-folder', name: 'New folder', serviceIds: [svc.id] }),
      },
    ],
  };

  const muted = svc.notificationLevel === 'muted';
  const mute: Electron.MenuItemConstructorOptions = {
    label: muted ? `Muted${svc.mutedUntil ? ` ${untilLabel(svc.mutedUntil)}` : ''}` : 'Mute',
    submenu: [
      ...(muted
        ? [
            {
              label: 'Unmute',
              click: () => dispatch({ type: 'mute-service', serviceId: svc.id, until: null }),
            },
            { type: 'separator' as const },
          ]
        : []),
      {
        label: 'For 1 hour',
        click: () =>
          dispatch({ type: 'mute-service', serviceId: svc.id, until: Date.now() + HOUR_MS }),
      },
      {
        label: 'Until tomorrow',
        click: () =>
          dispatch({ type: 'mute-service', serviceId: svc.id, until: tomorrowMorning(Date.now()) }),
      },
      {
        // Far enough away to mean "until I say so" — the same flag Settings' "Off" sets, just
        // reached from here.
        label: 'Until I unmute it',
        click: () =>
          dispatch({
            type: 'update-service',
            serviceId: svc.id,
            patch: { notificationLevel: 'muted' },
          }),
      },
      { type: 'separator' },
      {
        // The quieter setting between the two: counted, never a banner.
        label: 'Badge only, no banners',
        type: 'checkbox',
        checked: svc.notificationLevel === 'badge',
        click: () =>
          dispatch({
            type: 'update-service',
            serviceId: svc.id,
            patch: { notificationLevel: svc.notificationLevel === 'badge' ? 'all' : 'badge' },
          }),
      },
    ],
  };

  popup(
    [
      {
        label: `Open ${svc.name}`,
        click: () => dispatch({ type: 'focus-service', serviceId: svc.id }),
      },
      {
        label: 'Open in new pane',
        click: () => dispatch({ type: 'open-in-new-pane', serviceId: svc.id }),
      },
      {
        label: 'Open in separate window',
        click: () => dispatch({ type: 'pop-out-service', serviceId: svc.id }),
      },
      { type: 'separator' },
      {
        label: 'Mark as read',
        enabled: unread > 0,
        click: () => dispatch({ type: 'mark-read', serviceId: svc.id }),
      },
      mute,
      { label: 'Copy address', click: () => clipboard.writeText(currentUrl) },
      { type: 'separator' },
      moveTo,
      ...(otherWorkspaces.length
        ? [
            {
              label: 'Move to workspace',
              submenu: otherWorkspaces.map((w) => ({
                label: w.name,
                click: () =>
                  dispatch({ type: 'move-to-workspace', serviceId: svc.id, workspaceId: w.id }),
              })),
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: `Settings for ${svc.name}…`,
        click: () => dispatch({ type: 'open-settings', serviceId: svc.id }),
      },
      {
        label: 'Rename…',
        // Native menus can't prompt for text and Electron has no text dialog, so this used to fall
        // back to opening Settings. That is a page away and drops you on a list — no help at all
        // when the reason you are renaming is that two rows are both called "Teams". It edits the
        // name in the rail instead, which is the row you just right-clicked.
        click: () => dispatch({ type: 'begin-rename-service', serviceId: svc.id }),
      },
      ...(entry
        ? [
            {
              label: `Add another ${entry.name} account`,
              click: () =>
                dispatch({ type: 'add-service', catalogId: entry.id, forceNewAccount: true }),
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Reload',
        enabled: !isSleeping,
        click: () => dispatch({ type: 'reload-service', serviceId: svc.id }),
      },
      // Two items, not one relabelled. "Close pane" used to send `sleep-service`, which throws the
      // page away and puts a different service into the pane — the opposite of closing it.
      ...(paneId
        ? [{ label: 'Close pane', click: () => dispatch({ type: 'close-pane', paneId }) }]
        : []),
      {
        label: 'Put to sleep',
        enabled: !isSleeping,
        click: () => dispatch({ type: 'sleep-service', serviceId: svc.id }),
      },
      { type: 'separator' },
      {
        label: `Remove ${svc.name}…`,
        click: () => {
          // Destructive and not undoable — confirm. The account survives; only the tile goes.
          const { response } = dialogSyncRemove(window, svc.name);
          if (response === 0) dispatch({ type: 'remove-service', serviceId: svc.id });
        },
      },
    ],
    window,
  );
}

function dialogSyncRemove(window: BaseWindow, name: string): { response: number } {
  const response = dialog.showMessageBoxSync(window, {
    type: 'warning',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Remove ${name}?`,
    detail:
      // Every workspace, which is what `removeServiceFromConfig` does — the old wording said "this
      // workspace", and someone expecting to find it in their other one would not.
      'It is removed from every workspace. Its account and cookies are kept, so adding it back ' +
      'later will still be signed in.',
  });
  return { response };
}

export function showFolderMenu(
  window: BaseWindow,
  folder: { id: string; name: string; serviceIds: string[]; collapsed: boolean },
  dispatch: Dispatch,
): void {
  popup(
    [
      {
        label: folder.collapsed ? 'Expand' : 'Collapse',
        click: () => dispatch({ type: 'toggle-folder', folderId: folder.id }),
      },
      { type: 'separator' },
      { label: 'Rename…', click: () => dispatch({ type: 'begin-rename-folder', folderId: folder.id }) },
      {
        // Not "delete the services" — the folder goes, its contents are promoted to the top level.
        label: `Ungroup ${folder.name}`,
        click: () => dispatch({ type: 'delete-folder', folderId: folder.id }),
      },
    ],
    window,
  );
}

export function showRailMenu(window: BaseWindow, dispatch: Dispatch): void {
  popup(
    [
      { label: 'Add connection…', click: () => dispatch({ type: 'open-connections' }) },
      {
        label: 'New folder',
        click: () => dispatch({ type: 'create-folder', name: 'New folder' }),
      },
      { type: 'separator' },
      { label: 'Settings…', click: () => dispatch({ type: 'open-settings' }) },
    ],
    window,
  );
}

/**
 * Switching workspace from the rail. ⌘⌥1…9 worked and nothing on screen said so, or said which
 * workspace you were in, or that another one had messages waiting — this is all three.
 */
export function showWorkspaceMenu(
  window: BaseWindow,
  workspaces: Array<{ id: string; name: string; unread: number; active: boolean }>,
  dispatch: Dispatch,
): void {
  popup(
    [
      ...workspaces.map((w, i) => ({
        label: w.unread > 0 ? `${w.name}  (${w.unread})` : w.name,
        type: 'radio' as const,
        checked: w.active,
        // Shown, not registered — the same reason as the app menu: ⌘⌥n is dispatched elsewhere.
        ...(i < 9 ? { accelerator: `CmdOrCtrl+Alt+${i + 1}`, registerAccelerator: false } : {}),
        click: () => dispatch({ type: 'set-workspace', workspaceId: w.id }),
      })),
      { type: 'separator' },
      { label: 'New workspace', click: () => dispatch({ type: 'create-workspace', name: 'Workspace' }) },
      { label: 'Manage workspaces…', click: () => dispatch({ type: 'open-settings', section: 'workspaces' }) },
    ],
    window,
  );
}
