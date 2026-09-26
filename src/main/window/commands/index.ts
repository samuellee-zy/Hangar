import { dataCommands } from '@main/window/commands/data';
import { paneCommands } from '@main/window/commands/panes';
import { preferenceCommands } from '@main/window/commands/preferences';
import { serviceCommands } from '@main/window/commands/services';
import { surfaceCommands } from '@main/window/commands/surfaces';
import { workspaceCommands } from '@main/window/commands/workspaces';
import type { Command } from '@shared/types';
import type { CommandTable, CommandType, Handler, ShellContext } from '@main/window/commands/context';

export type { ShellContext } from '@main/window/commands/context';

/**
 * Every command, by type. One table assembled from the per-concern files, so the question "where is
 * `move-item` handled" has one answer, and a type appearing in two files is caught below rather
 * than one silently winning.
 */
const tables: CommandTable[] = [
  paneCommands,
  serviceCommands,
  workspaceCommands,
  preferenceCommands,
  dataCommands,
  surfaceCommands,
];

const HANDLERS: CommandTable = {};
for (const table of tables) {
  for (const type of Object.keys(table) as CommandType[]) {
    if (type in HANDLERS) throw new Error(`command ${type} is handled twice`);
    (HANDLERS as Record<string, unknown>)[type] = table[type];
  }
}

/** Which command types have a handler. For the test that every type is covered. */
export const handledTypes = (): CommandType[] => Object.keys(HANDLERS) as CommandType[];

/**
 * Runs a command. Returns whether anything happened — false for a type with no handler, or when the
 * handler says so (see `Handler`).
 */
export function route(command: Command, shell: ShellContext): boolean {
  const handler = HANDLERS[command.type] as Handler<typeof command.type> | undefined;
  if (!handler) {
    console.warn(`[command] no handler for ${command.type}`);
    return false;
  }
  return handler(command as never, shell) !== false;
}
