import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render error so a route fails visibly instead of vanishing.
 *
 * Each route is its own `WebContentsView`, which makes an uncaught error worse here than in an
 * ordinary web page. React unmounts the whole tree on a render throw, leaving an empty `#root` — and
 * an empty root in a view that *is* the rail means the rail is simply gone. No blank page, no
 * console the user will ever look at, no way back short of quitting. The overlay and find bar fail
 * the same way and read as an unresponsive shortcut.
 *
 * There is deliberately no fallback UI beyond an explanation and a reload. Anything cleverer would
 * be guessing at which part of the state is intact, and this only runs when that question has no
 * good answer.
 */
export class ErrorBoundary extends Component<
  { route: string; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The main process collects renderer console output, so this is the only record that survives.
    console.error(`[${this.props.route}] render failed:`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="route-error" role="alert">
        <h1>{this.props.route} stopped working</h1>
        <p>
          Something in this panel threw an error. The rest of Hangar is unaffected — your services
          keep running, and nothing has been written to your config.
        </p>
        <pre className="route-error-detail">{error.message}</pre>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload this panel
        </button>
      </div>
    );
  }
}
