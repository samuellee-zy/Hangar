import { useEffect, useState } from 'react';
import type { ResourceMetrics } from '@shared/resources';

export function Resources() {
  const [metrics, setMetrics] = useState<ResourceMetrics | null>(null);
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!watching) return;
    let live = true, pending = false;
    const read = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try { const value = await window.hangar.getMetrics(); if (live) setMetrics(value); }
      finally { pending = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 2_000);
    return () => { live = false; clearInterval(timer); };
  }, [watching]);
  return <section>
    <h2>Resource use</h2>
    <p className="hint">Resident memory excludes compressed pages and can include shared memory. CPU and wakeups are interval averages; the first sample is a baseline.</p>
    <button className="secondary" onClick={() => setWatching(!watching)}>{watching ? 'Stop measuring' : 'Measure resource use'}</button>
    {metrics && <>
      <p>{metrics.processes} processes · {Math.round(metrics.residentMb)} MB resident · {metrics.cpuPercent.toFixed(1)}% CPU · {metrics.wakeupsPerSecond.toFixed(1)} wakeups/s</p>
      <ul className="rows">{metrics.details.map((process) => <li className="pref" key={process.pid}>
        <span className="pref-label"><span className="pref-name">{process.labels.join(' · ')}</span><span className="pref-note">{process.type} · PID {process.pid}</span></span>
        <span>{Math.round(process.residentMb)} MB · {process.cpuPercent.toFixed(1)}% CPU</span>
      </li>)}</ul>
    </>}
  </section>;
}
