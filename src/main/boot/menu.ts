import { Menu, app, type MenuItemConstructorOptions } from 'electron';
import { KEY_ACTIONS, primaryChord, type Bindings } from '@core/keyboard/keymap';
import { dndMenu } from '@main/features/tray';
import { toAccelerator } from '@shared/keyboard';
import type { Command, ShellState } from '@shared/types';

/**
 * Owning the menu is not cosmetic — it's the only way to own the keys.
 *
 * Electron installs a default menu when you don't, and its Window submenu binds ⌘W to the `close`
 * role. That accelerator fires at the app level regardless of what `before-input-event` does, so
 * ⌘W closed the whole window even when the intent was "close this pane". Replacing the menu is
 * what makes our binding authoritative.
 *
 * ## Why nothing here registers an accelerator
 *
 * Our own items are declared with `registerAccelerator: false`: the chord is *drawn* beside the
 * label, and Electron does not bind it. Rebinding is impossible otherwise — a registered
 * accelerator fires at the application level, ahead of `before-input-event`, so a ⌘K moved to ⌘J
 * would keep opening the palette from the menu's copy of the fact. With registration off,
 * `window/shortcuts.ts` is the only dispatcher and `core/keyboard/keymap.ts` the only table.
 *
 * Roles are the exception and keep their real accelerators. ⌘C has to work inside a web app
 * whether or not our keymap has an opinion, and those chords are refused to rebinding for exactly
 * that reason (`RESERVED_CHORDS`).
 *
 * The labels and order come from `KEY_ACTIONS` too, so the menu cannot drift from Settings — it
 * already had, listing ⌘F and ⌘P that Settings never mentioned.
 */

/**
 * Kept so a rebind can redraw the menu without the caller re-supplying its wiring. Module state
 * because there is exactly one application menu, which is also why `Menu.setApplicationMenu` is a
 * static.
 */
let installed: {
  dispatch: (command: Command) => boolean;
  bindings: () => Bindings;
  /** What the Go menu lists and the Dock menu counts. Null while there is no window. */
  state: () => ShellState | null;
} | null = null;

export function installMenu(
  dispatch: (command: Command) => boolean,
  bindings: () => Bindings,
  state: () => ShellState | null,
): void {
  installed = { dispatch, bindings, state };
  build();
}

/**
 * Redraws the menu against the current bindings.
 *
 * A no-op before `installMenu`, which is not defensive padding: `AppWindow` calls this from its
 * state broadcast, and the window is constructed before the menu is installed.
 */
export function refreshMenu(): void {
  if (installed) build();
}

function build(): void {
  const { dispatch, bindings } = installed!;
  const send = (command: Command) => () => dispatch(command);
  const current = bindings();
  const state = installed!.state();
  const open = (serviceId: string) => () => {
    dispatch({ type: 'show-window' });
    dispatch({ type: 'focus-service', serviceId });
  };

  /**
   * The labels that depend on state, each saying what choosing it would do: it said "Maximise pane"
   * while a pane was maximised.
   */
  const labelOf = (action: (typeof KEY_ACTIONS)[number]): string => {
    if (action.id === 'maximise-pane' && state?.maximisedPaneId) return 'Restore panes';
    if (action.id === 'layout-shape') {
      return state?.layoutShape === 'main-stack' ? 'Put panes side by side' : 'One large pane, the rest stacked';
    }
    return action.label;
  };

  /** The items for one menu, with their separators, drawn from the single table. */
  const items = (menu: 'app' | 'file' | 'view' | 'go' | 'help'): MenuItemConstructorOptions[] =>
    KEY_ACTIONS.filter((action) => action.menu === menu).flatMap((action) => {
      const accelerator = toAccelerator(current[action.id] ?? '');
      const item: MenuItemConstructorOptions = {
        label: labelOf(action),
        click: send(action.command),
        // Shown, not bound. See the module comment — this is the whole reason rebinding works.
        ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
      };
      return action.group ? [{ type: 'separator' } as MenuItemConstructorOptions, item] : [item];
    });

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...items('app'),
        ...(state ? [dndMenu(state, dispatch)] : []),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        ...items('file'),
        { type: 'separator' },
        { label: 'Export configuration…', click: send({ type: 'export-config' }) },
        { label: 'Import configuration…', click: send({ type: 'import-config' }) },
      ],
    },
    // Roles, not custom handlers: without an Edit menu, ⌘C/⌘V/⌘A don't work inside the web apps.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [...items('view'), { type: 'separator' }, { role: 'toggleDevTools' }],
    },
    // ⌘1–9 and ⌘⌥1–9 were in no menu at all: positional, so there was nothing to hang them on. The
    // services and workspaces themselves are the items, with the chord that reaches each.
    { label: 'Go', submenu: goMenu(state, open, send, items('go')) },
    // Deliberately no { role: 'close' } anywhere — that's the binding that was stealing ⌘W.
    //
    // "Show Hangar" because `role: 'front'` only raises windows that are *visible*. A window closed
    // to the tray is hidden, and with the menu bar showing Hangar's menus and no window at all,
    // there was nothing here that could bring it back.
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Show Hangar', click: send({ type: 'show-window' }) },
        { role: 'front' },
      ],
    },
    // `role: 'help'` is what gives the menu bar its search field, which finds every item above by
    // name — the fastest way to an action whose chord you don't remember.
    {
      role: 'help',
      submenu: [
        ...items('help'),
        { label: 'Show the log file', click: send({ type: 'reveal', what: 'log' }) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // Right-clicking the Dock icon: one more route back that doesn't depend on the tray being
  // visible — on a notched MacBook a crowded menu bar hides extras behind the camera housing.
  //
  // Services with something unread, and Do Not Disturb: the two things worth reaching from the Dock
  // without opening the window first. It had only "Show Hangar".
  const waiting = (state?.allServices ?? []).filter((svc) => svc.unread > 0).slice(0, 8);
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      { label: 'Show Hangar', click: send({ type: 'show-window' }) },
      ...(waiting.length
        ? [
            { type: 'separator' as const },
            ...waiting.map((svc) => ({ label: `${svc.name} (${svc.unread})`, click: open(svc.id) })),
          ]
        : []),
      ...(state ? [{ type: 'separator' as const }, dndMenu(state, dispatch)] : []),
    ])
  );
}

/** Services, then workspaces, each with the positional chord that reaches it, then the Go actions. */
function goMenu(
  state: ShellState | null,
  open: (serviceId: string) => () => void,
  send: (command: Command) => () => boolean,
  actions: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  const shown = (chord: string) => ({ accelerator: toAccelerator(chord), registerAccelerator: false });
  const services: MenuItemConstructorOptions[] = (state?.services ?? []).map((svc, i) => ({
    label: svc.unread > 0 ? `${svc.name} (${svc.unread})` : svc.name,
    click: open(svc.id),
    ...(i < 9 ? shown(primaryChord(String(i + 1))) : {}),
  }));
  const workspaces: MenuItemConstructorOptions[] =
    (state?.workspaces.length ?? 0) > 1
      ? state!.workspaces.map((ws, i) => ({
          label: ws.name,
          type: 'radio' as const,
          checked: ws.id === state!.activeWorkspaceId,
          click: send({ type: 'set-workspace', workspaceId: ws.id }),
          ...(i < 9 ? shown(primaryChord(String(i + 1), { alt: true })) : {}),
        }))
      : [];
  return [
    ...services,
    ...(workspaces.length ? [{ type: 'separator' as const }, ...workspaces] : []),
    ...actions,
  ];
}
