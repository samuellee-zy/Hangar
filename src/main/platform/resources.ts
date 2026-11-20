import { app, webContents, type WebContents } from 'electron';
import type { ResourceMetrics } from '@shared/resources';

/** On demand only. One row per OS process, even when several views share it. */
export function resourceMetrics(label: (wc: WebContents) => string | null): ResourceMetrics {
  const labels = new Map<number, Set<string>>();
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    const pid = wc.getOSProcessId();
    const name = label(wc) ?? (wc.getURL().startsWith('file:') ? `Hangar ${new URL(wc.getURL()).hash.slice(1) || 'interface'}` : 'Web content');
    if (!labels.has(pid)) labels.set(pid, new Set());
    labels.get(pid)!.add(name);
  }
  const details = app.getAppMetrics().map((m) => ({
    pid: m.pid, type: m.type, labels: [...(labels.get(m.pid) ?? [m.name || m.type])],
    residentMb: m.memory.workingSetSize / 1024,
    cpuPercent: m.cpu.percentCPUUsage,
    wakeupsPerSecond: m.cpu.idleWakeupsPerSecond,
  }));
  return {
    processes: details.length, sampledAt: Date.now(), details,
    residentMb: details.reduce((n, p) => n + p.residentMb, 0),
    cpuPercent: details.reduce((n, p) => n + p.cpuPercent, 0),
    wakeupsPerSecond: details.reduce((n, p) => n + p.wakeupsPerSecond, 0),
  };
}
