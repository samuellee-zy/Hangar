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
}: {
  serviceId: string;
  initials: string;
  name: string;
}) {
  const [failed, setFailed] = useState(false);

  // A custom connection's favicon arrives after the first load, so a permanent latch meant the
  // icon could never appear without restarting. Retry whenever the service identity changes.
  useEffect(() => setFailed(false), [serviceId]);

  if (failed) return <span className="rail-initials">{initials}</span>;

  return (
    <img
      className="rail-icon"
      src={`hangar-icon://${serviceId}`}
      alt={name}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
