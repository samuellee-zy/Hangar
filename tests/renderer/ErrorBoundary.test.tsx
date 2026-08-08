// Every renderer route is its own WebContentsView, which makes an uncaught render error worse than
// it would be on the web: React unmounts the tree, `#root` goes empty, and an empty root in the
// view that *is* the rail means the rail is simply gone. No error page, no console anyone will
// look at, no way back short of quitting.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../../src/renderer/ErrorBoundary';

function Boom({ message = 'kaboom' }: { message?: string }): never {
  throw new Error(message);
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs the caught error itself, which is noise here and would drown a real failure.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => consoleError.mockRestore());

describe('a route that throws', () => {
  it('SHOWS SOMETHING rather than leaving an empty view', () => {
    render(
      <ErrorBoundary route="rail">
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent(/rail stopped working/i);
  });

  it('names the route, so the message is not the same for all five', () => {
    render(
      <ErrorBoundary route="settings">
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('heading')).toHaveTextContent(/settings/i);
  });

  it('shows the error message, which is the only record the user can see', () => {
    render(
      <ErrorBoundary route="overlay">
        <Boom message="cannot read properties of undefined" />
      </ErrorBoundary>
    );

    expect(screen.getByText(/cannot read properties of undefined/)).toBeInTheDocument();
  });

  it('logs to the console, which is what main collects', () => {
    render(
      <ErrorBoundary route="find">
        <Boom />
      </ErrorBoundary>
    );

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[find] render failed:'),
      expect.any(Error),
      expect.anything()
    );
  });

  it('offers a reload, since there is no other way back', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      writable: true,
    });

    render(
      <ErrorBoundary route="rail">
        <Boom />
      </ErrorBoundary>
    );
    await userEvent.click(screen.getByRole('button', { name: /reload/i }));

    expect(reload).toHaveBeenCalled();
  });
});

describe('a route that works', () => {
  it('renders its children untouched, with no wrapper markup in the way', () => {
    // Otherwise the boundary is a permanent error page and the tests above pass for free.
    render(
      <ErrorBoundary route="rail">
        <p>the actual rail</p>
      </ErrorBoundary>
    );

    expect(screen.getByText('the actual rail')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
