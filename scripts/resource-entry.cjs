// Test-only native driver: no debugger, focus emulation or Chromium scheduler overrides.
// Used exclusively with a throwaway HANGAR_USER_DATA profile by benchmark-resources.mjs.
const { app, webContents } = require('electron');
if (!process.send || !process.env.HANGAR_USER_DATA) throw new Error('Resource driver needs an isolated profile and IPC');
require(process.env.HANGAR_RESOURCE_ENTRY);
process.on('message', async ({ id, action, value }) => {
  try {
    const shell = globalThis.__hangarShell;
    let result;
    if (action === 'ready') result = !!shell && !shell.win.isDestroyed() && shell.state().allServices.some((s) => !s.sleeping);
    else if (action === 'sample') {
      const metrics = app.getAppMetrics();
      result = { residentMb: metrics.reduce((n, m) => n + m.memory.workingSetSize / 1024, 0),
        cpuPercent: metrics.reduce((n, m) => n + m.cpu.percentCPUUsage, 0),
        wakeupsPerSecond: metrics.reduce((n, m) => n + m.cpu.idleWakeupsPerSecond, 0),
        processes: metrics.length, contents: webContents.getAllWebContents().length,
        services: shell.state().allServices.filter((s) => !s.sleeping).length };
    } else if (action === 'focus') shell.dispatch({ type: 'focus-service', serviceId: value });
    else if (action === 'show') { app.focus({ steal: true }); shell.win.show(); shell.win.focus(); }
    else if (action === 'hide') shell.win.hide();
    else if (action === 'wake') { shell.win.show(); shell.refreshAfterWake(600_000); }
    else if (action === 'timers') {
      result = await Promise.all(value.map(async (serviceId) => {
        const wc = shell.services.get(serviceId)?.view.webContents;
        if (!wc || wc.isDestroyed() || wc.isLoading()) return null;
        return { throttled: wc.getBackgroundThrottling(), ...await wc.executeJavaScript('({ hidden: document.hidden, ticks: window.ticks })') };
      }));
    } else if (action === 'quit') app.quit();
    else throw new Error(`Unknown action: ${action}`);
    if (process.connected) process.send({ id, result });
  } catch (error) { if (process.connected) process.send({ id, error: String(error.stack || error) }); }
});
