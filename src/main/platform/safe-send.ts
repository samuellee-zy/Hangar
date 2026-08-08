/**
 * Sending to a renderer that may already be gone.
 *
 * Lifted out of `app-window.ts` so the overlay and the find bar can use it too. Both were calling
 * `webContents.send` raw, which meant the one helper written specifically to survive a crashed
 * renderer was applied to the state broadcast and not to the two surfaces a user opens by hand.
 */

/**
 * `isDestroyed()` is not sufficient. A renderer that has crashed — or is being torn down — reports
 * `false` while its underlying render frame is already gone, and `send` then throws
 * "Render frame was disposed before WebFrameMain could be accessed".
 *
 * That matters beyond tidiness: a crash makes every consumer throw a stack trace at once, and that
 * volume of noise is exactly what buried three separate bugs earlier in this project. A broadcast
 * to a view that no longer exists is not an error worth reporting.
 *
 * The frame check is not belt-and-braces on the `catch` below — it is the only thing that works.
 * `webContents.send` delegates to `webFrameMain.send`, which catches the disposed-frame throw
 * itself and reports it with `console.error` rather than letting it out. A `try` here never sees
 * it, and the log line lands regardless. That line is what killed the app on a wake once stdout had
 * gone away with the terminal that started it, so declining to send is the fix, not the tidying.
 */
export function safeSend(wc: Electron.WebContents, channel: string, payload?: unknown): void {
  if (wc.isDestroyed()) return;
  try {
    // Reading `mainFrame` on a webContents torn down since the check above throws in its own right.
    const frame = wc.mainFrame;
    if (!frame || frame.isDestroyed()) return;
    frame.send(channel, payload);
  } catch {
    // The view went away between the check and the send. Nothing to do and nothing to say.
  }
}
