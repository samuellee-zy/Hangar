import { useEffect, useState } from 'react';

/**
 * Renders the service's logo, falling back to initials.
 *
 * The fallback is load-driven rather than state-driven on purpose: main resolves
 * `hangar-icon://<id>` from either a vendored logo or a captured favicon, and the renderer has no
 * business knowing which — or whether a favicon has arrived yet. A 404 simply means "no icon
 * today", and the tile stays readable either way.
 */
export function ServiceIcon({
  serviceId,
  initials,
  name,
  version = 0,
}: {
  serviceId: string;
  initials: string;
  name: string;
  /** `ServiceView.iconVersion`: moves when main caches a new favicon. */
  version?: number;
}) {
  const [failed, setFailed] = useState(false);

  // A favicon arrives after the first load, so a permanent latch meant the icon could never appear
  // without restarting. Retry when the service changes, or when main says a new icon was cached —
  // the version is in the URL too, so the retry isn't answered from the 404 it already had.
  useEffect(() => setFailed(false), [serviceId, version]);

  if (failed) return <span className="rail-initials">{initials}</span>;

  return (
    <img
      className="rail-icon"
      src={iconUrl(serviceId, version)}
      alt={name}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** The icon's address. The version is ignored by main's handler and exists to change the URL. */
export function iconUrl(serviceId: string, version = 0): string {
  return version ? `hangar-icon://${serviceId}?v=${version}` : `hangar-icon://${serviceId}`;
}
