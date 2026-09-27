// Fails when the renderer's entry chunk grows past a budget.
//
// The entry is what every one of the app's own views parses before drawing anything — the rail, the
// overlay, Settings, the find bar, the drag layer, the empty view. It was 831 KB unminified and
// nobody noticed, because nothing measured it. Run after `electron-vite build`.

import fs from 'node:fs';
import path from 'node:path';

const ENTRY_BUDGET_KB = 260;
const TOTAL_BUDGET_KB = 600;

const dir = path.join(import.meta.dirname, '..', 'out', 'renderer', 'assets');
if (!fs.existsSync(dir)) {
  console.error(`no build at ${dir} — run \`npm run build\` first`);
  process.exit(1);
}

const scripts = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const kb = (file) => fs.statSync(path.join(dir, file)).size / 1024;
const entry = scripts.find((f) => f.startsWith('index-'));
if (!entry) {
  console.error('no index-*.js entry chunk in the build');
  process.exit(1);
}

const entryKb = kb(entry);
const totalKb = scripts.reduce((sum, f) => sum + kb(f), 0);
console.log(`renderer entry ${entryKb.toFixed(0)} KB (budget ${ENTRY_BUDGET_KB}), all chunks ${totalKb.toFixed(0)} KB (budget ${TOTAL_BUDGET_KB})`);

if (entryKb > ENTRY_BUDGET_KB || totalKb > TOTAL_BUDGET_KB) {
  console.error('over budget: something large joined the entry, or a route stopped being lazy');
  process.exit(1);
}
