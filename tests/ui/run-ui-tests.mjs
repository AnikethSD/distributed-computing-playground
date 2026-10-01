#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 AnikethSD
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Runs tests/ui/ui-spec.js against index.html in headless Chrome.
 *
 * Builds a temporary copy of index.html with absolute file:// URLs, a fresh
 * localStorage and the spec injected after the app, then uses --dump-dom to
 * read the PASS/FAIL log. Exits non-zero on any failure.
 *
 *   node tests/ui/run-ui-tests.mjs            # auto-detects Chrome/Chromium
 *   CHROME_BIN=/path/to/chrome node tests/ui/run-ui-tests.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function findChrome() {
  const candidates = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const bin of candidates.filter(Boolean)) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch { /* try the next candidate */ }
  }
  throw new Error('Chrome/Chromium not found. Set CHROME_BIN to run the UI tests.');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbp-ui-'));
const rootUrl = pathToFileURL(root + path.sep).href;
const spec = fs.readFileSync(path.join(here, 'ui-spec.js'), 'utf8');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/(href|src)="(src\/[^"]+)"/g, (_, attr, rel) => `${attr}="${rootUrl}${rel}"`)
  .replace('<body>', '<body><script>localStorage.clear();</script>')
  // Function replacer: the spec contains "$'" sequences that String#replace would expand.
  .replace('</body>', () => `<script>\n${spec}\n</script>\n</body>`);
const page = path.join(tmp, 'ui-test.html');
fs.writeFileSync(page, html);

let dom = '';
try {
  dom = execFileSync(findChrome(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions',
    `--user-data-dir=${path.join(tmp, 'profile')}`,
    '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(page).href,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The spec source is inlined in the page, so take the last TESTLOG element (the real output).
const match = [...dom.matchAll(/<pre id="TESTLOG">([\s\S]*?)<\/pre>/g)].pop();
if (!match) {
  console.error('UI spec did not produce a TESTLOG. The app probably threw during start-up.');
  process.exit(1);
}
const decode = (s) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const lines = decode(match[1]).split('\n').filter(Boolean);
const failed = lines.filter((l) => l.startsWith('FAIL'));
for (const line of lines) console.log(line.startsWith('PASS') ? `  ✔ ${line.slice(5)}` : `  ✖ ${line.slice(5)}`);
console.log(`\n${lines.length - failed.length}/${lines.length} UI checks passed`);
process.exit(failed.length ? 1 : 0);
