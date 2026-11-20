// Synthetic local pages, isolated profile, no accounts or external network. Build before running.
// --entry out-check/resource-baseline/out/main/index.js --output out-check/resources-before.json
// --optimised --output out-check/resources-after.json
import electron from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const optimised = process.argv.includes('--optimised');
const visibilityOnly = process.argv.includes('--visibility-only');
const settleSeconds = Number(option('--settle-seconds', '600'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hangar-resource-benchmark-'));
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Resource fixture</title><input aria-label="Draft"><script>window.fixtureMemory = new Uint8Array(16*1024*1024); fixtureMemory.fill(42); window.ticks=0; setInterval(()=>window.ticks++,100);</script>');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const services = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `Fixture ${i}`, catalogId: '__custom',
  url: `${origin}/${i}`, accountId: `a${i}`, allowedHosts: ['127.0.0.1'], notifications: true, hibernate: true, keepRunning: i < 5, zoom: 1 }));
await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 5, services,
  accounts: services.map((s, i) => ({ id: s.accountId, label: s.name, provider: 'custom', partition: `persist:fixture-${i}` })),
  workspaces: [{ id: 'w', name: 'Benchmark', items: services.map((s) => ({ kind: 'service', id: s.id })) }],
  activeWorkspaceId: 'w', layouts: {}, preferences: { network: { blockAds: false },
    behaviour: { hibernateAfterMinutes: optimised ? 5 : 30, maxCachedServices: optimised ? 2 : 0 } } }));
const { ELECTRON_RUN_AS_NODE: _asNode, ...env } = process.env;
let app;
const samples = [];
try {
  app = spawn(electron, [path.resolve('scripts/resource-entry.cjs')], {
    env: { ...env, HANGAR_RESOURCE_ENTRY: path.resolve(option('--entry', 'out/main/index.js')), HANGAR_USER_DATA: profile, HANGAR_E2E: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let log = '', sequence = 0;
  const pending = new Map();
  for (const stream of [app.stdout, app.stderr]) stream.on('data', (chunk) => { log = (log + chunk).slice(-16000); });
  app.on('message', ({ id, result, error }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    if (error) request.reject(new Error(error)); else request.resolve(result);
  });
  app.on('exit', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Electron exited: ${log}`)); }
    pending.clear();
  });
  const rpc = (action, value) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${action} timed out: ${log}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    app.send({ id, action, value });
  });
  for (let i = 0; ; i++) {
    if (await rpc('ready')) break;
    if (i > 100) throw new Error(`App did not start: ${log}`);
    await delay(100);
  }
  const sample = async (stage) => {
    const value = await rpc('sample');
    samples.push({ stage, at: Date.now(), ...value });
    return value;
  };
  if (visibilityOnly) {
    await delay(7000);
    await rpc('show');
    await delay(500);
    const before = await rpc('timers', ['s0', 's1']);
    await delay(3000);
    const after = await rpc('timers', ['s0', 's1']);
    console.log(JSON.stringify({ before, after }));
  } else {
    for (let i = 0; i < 15; i++) { await delay(1_000); await sample('startup'); }
    for (const service of services) {
      await rpc('focus', service.id);
      await delay(1_000);
    }
    console.log(JSON.stringify({ stage: 'all-visited', ...await sample('all-visited') }));
    // Keep both runs hidden throughout the idle window so other desktop tests cannot occlude only one.
    await rpc('hide');
    for (let i = 0; i < settleSeconds; i += 10) { await delay(10_000); await sample('settled'); }
    await rpc('hide');
    for (let i = 0; i < 6; i++) { await delay(5_000); await sample('hidden'); }
    await rpc('wake');
    for (let i = 0; i < 15; i++) { await delay(1_000); await sample('wake'); }
    const summary = { synthetic: true, optimised, settleSeconds, samples };
    await fs.writeFile(option('--output', 'out-check/resources.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ stage: 'final', ...samples.at(-1) }));
  }
  await rpc('quit');
} finally {
  if (app && app.exitCode === null && app.signalCode === null) {
    let timeout;
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), new Promise((resolve) => { timeout = setTimeout(resolve, 10000); })]);
    clearTimeout(timeout);
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGTERM');
  }
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
