import { nativeTheme } from 'electron';
import { loadConfig } from '@main/platform/config';
import { applyGlobalShortcut, applyLoginItem, applyProxy } from '@main/platform/system';
import { allLiveSessions, applyAdBlockingEverywhere } from '@main/platform/session';
import { destroyTray, ensureTray } from '@main/features/tray';
import type { PushManager } from '@main/features/push-manager';
import {
  ALL_PREFERENCE_EFFECTS,
  effectsForChange,
  preferenceEffectFor,
  trayWanted,
  type PreferenceEffect,
} from '@core/config/effects';
import { firebaseConfigStatus } from '@core/push/policy';
import type { Command, Preferences, ShellState } from '@shared/types';

/**
 * The preferences that configure something outside the config — launchd, the proxy, the global
 * shortcut, the tray, push sockets, the ad blocker, spellcheck.
 *
 * Which path needs which effect is decided in `core/config/effects.ts`; this is the *how*, in one
 * place. It was four copies at one point, and the copy that missed the tray's `closeToTray`
 * condition is the reason it is one now.
 */
export interface EffectsHost {
  state(): ShellState;
  dispatch(command: Command): boolean;
  readonly push: PushManager;
  /** What the global shortcut does: hide the window if it's showing, show it otherwise. */
  toggleWindow(): void;
}

export class PreferenceEffects {
  constructor(private readonly host: EffectsHost) {}

  /**
   * Boot, and again when `activate` rebuilds the window — preference *changes* go through
   * `applyFor`.
   *
   * A deliberate subset, not an oversight, and the two omissions have reasons worth stating:
   * `push` is already started by the constructor and starting it twice opens a second set of FCM
   * sockets, which is how every notification once arrived twice; `spellcheck` is read when a
   * session is created, and at this point none exist yet.
   */
  applySystem(): void {
    for (const effect of ['login-item', 'proxy', 'shortcut', 'tray'] as const) this.run(effect);
  }

  /**
   * Every preference effect at once, for a reset.
   *
   * Previously reset re-ran only the system subset above, which left push sockets open while
   * Settings reported push off, and live sessions on the old spellcheck languages until restart.
   * Iterates the effect tags themselves, so a new effect cannot be missed here.
   */
  applyAll(): void {
    for (const effect of ALL_PREFERENCE_EFFECTS) this.run(effect);
    nativeTheme.themeSource = loadConfig().preferences.appearance.theme;
  }

  /**
   * After preferences were replaced wholesale — an incoming sync, an import: every effect whose
   * preference differs from `before`, and the theme. See `effectsForChange`.
   */
  applyChanged(before: Preferences): void {
    const now = loadConfig().preferences;
    if (now.appearance.theme !== before.appearance.theme) {
      nativeTheme.themeSource = now.appearance.theme;
    }
    for (const effect of effectsForChange(before, now)) this.run(effect);
  }

  /**
   * Only the effect the changed key actually needs. Re-running everything meant adjusting the rail
   * size re-registered the global shortcut and kicked off an unawaited proxy fan-out across every
   * session — harmless today, but exactly the shape that produces a race later.
   */
  applyFor(path: string): void {
    const effect = preferenceEffectFor(path);
    if (effect) this.run(effect);
  }

  /**
   * Performs one effect, and contains its failure.
   *
   * Each one reaches outside the app — the file system, launchd, the menu bar, a network — and a
   * throw from any of them used to escape into whatever called it. At boot that was
   * `applySystemPreferences`, so a `new Tray()` that failed took down the rest of startup with it,
   * and one broken effect in a reset skipped every effect after it.
   */
  run(effect: PreferenceEffect): void {
    try {
      this.perform(effect);
    } catch (err) {
      console.error(`[effect] ${effect} failed:`, err);
    }
  }

  private perform(effect: PreferenceEffect): void {
    const prefs = loadConfig().preferences;
    switch (effect) {
      case 'login-item':
        applyLoginItem(prefs);
        return;

      case 'proxy':
        // Async, so `run`'s try/catch cannot see its rejection.
        void applyProxy(allLiveSessions().values(), prefs).catch((err) =>
          console.error('[effect] proxy failed:', err),
        );
        return;

      case 'adblock':
        // Per session, so an account that has its own setting keeps it.
        applyAdBlockingEverywhere();
        return;

      case 'shortcut':
        applyGlobalShortcut(prefs.behaviour.globalShortcut, () => this.host.toggleWindow());
        return;

      case 'tray':
        // Symmetric: `destroyTray` existed and was never called, so the icon outlived its setting.
        if (trayWanted(prefs)) {
          ensureTray(
            () => this.host.state(),
            (c) => this.host.dispatch(c),
          );
        } else destroyTray();
        return;

      case 'push':
        // Switching push off must actually close the sockets, not just stop new subscriptions.
        if (prefs.notifications.push && firebaseConfigStatus(prefs.notifications.firebase) === 'ready') {
          this.host.push.start(loadConfig().services.map((s) => s.id));
        } else {
          this.host.push.stopAll();
        }
        return;

      case 'spellcheck':
        // Read once per session at creation, so existing sessions need telling.
        for (const ses of allLiveSessions().values()) {
          ses.setSpellCheckerLanguages(prefs.behaviour.spellcheckLanguages);
        }
        return;
    }
  }
}
