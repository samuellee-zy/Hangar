/**
 * What to ask before ending something a service is in the middle of. Pure, so the wording is
 * tested; `AppWindow.busyReason` decides whether a service is busy, and the dialogs are main's.
 *
 * Unloading a service — putting it to sleep, popping it out, quitting — ends its call. Nothing
 * asked first, and to the idle sweep a huddle in Slack's own window, with no Slack pane on screen,
 * looked as idle as anything else.
 */

/** A call (the meeting probe saw one), or sound from the page or one of its windows. */
export type BusyReason = 'call' | 'audio';

export interface BusyService {
  name: string;
  reason: BusyReason;
}

const doing = ({ name, reason }: BusyService): string =>
  reason === 'call' ? `${name} is in a call` : `${name} is playing audio`;

const ending = (reason: BusyReason): string => (reason === 'call' ? 'end the call' : 'stop the sound');

export interface Prompt {
  message: string;
  detail: string;
  /** The button that goes ahead. The other is Cancel, and it's the default. */
  confirm: string;
}

/** Putting one service to sleep, or popping it out — both unload the page. */
export function interruptPrompt(busy: BusyService, action: 'sleep' | 'pop-out'): Prompt {
  if (action === 'pop-out') {
    return {
      message: `${doing(busy)}. Pop it out?`,
      detail: `Its own window loads the page afresh, which will ${ending(busy.reason)}.`,
      confirm: 'Pop out',
    };
  }
  return {
    message: `${doing(busy)}. Put it to sleep?`,
    detail: `Sleeping unloads the page, which will ${ending(busy.reason)}.`,
    confirm: 'Put to sleep',
  };
}

/** Quitting with services busy. Null with none, so the caller falls back to "Confirm before quitting". */
export function quitPrompt(busy: readonly BusyService[]): Prompt | null {
  if (busy.length === 0) return null;
  const calls = busy.some((b) => b.reason === 'call');
  const sentence = busy.length === 1
    ? doing(busy[0]!)
    : `${busy.slice(0, -1).map(doing).join(', ')} and ${doing(busy.at(-1)!)}`;
  return {
    message: `${sentence}. Quit Hangar?`,
    detail: calls ? 'Quitting ends every call in it.' : 'Quitting stops the sound.',
    confirm: 'Quit',
  };
}
