#!/usr/bin/env node
// Refresh the bundled CelesTrak TLE snapshot.
//
// CelesTrak (Cloudflare) blocks datacenter IPs, so the always-on backend on
// Render cannot fetch TLEs live. This script — run from an unblocked machine
// (your laptop) or CI that CelesTrak allows — pulls the exact GROUP feeds the
// satellites layer needs and writes them to data/tle/<group>.tle. The backend
// serves these as a fallback (see celestrakProxy in vite.config.js).
//
// Usage:  npm run refresh-tle    then commit the changed data/tle/*.tle files.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'tle');

// The exact path segments the client requests via /api/celestrak/<group>.
// (src/data/satellites.js: CATALOG_GROUPS[].path + DENSE_GROUP_PATH)
// starlink is fetched FIRST: it's the bulk group CelesTrak 403s when it arrives
// after a burst of other requests, so it gets the freshest rate-limit budget.
const GROUPS = ['starlink', 'stations', 'visual', 'gps-ops', 'glo-ops', 'galileo', 'geo'];

// Space requests out — CelesTrak throttles rapid back-to-back GROUP pulls.
const REQUEST_SPACING_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA = 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/quiet-quark/gods-eye-view-konectu)';

async function fetchGroup(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'tle');
  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
  return body;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  let failures = 0;
  for (let i = 0; i < GROUPS.length; i += 1) {
    const group = GROUPS[i];
    if (i > 0) await sleep(REQUEST_SPACING_MS);
    try {
      const body = await fetchGroup(group);
      const count = (body.match(/^1 /gm) || []).length;
      await writeFile(path.join(OUT_DIR, `${group}.tle`), body, 'utf8');
      console.log(`  ${group.padEnd(10)} -> ${count} objects`);
    } catch (err) {
      failures += 1;
      console.error(`  ${group.padEnd(10)} -> FAILED (${err?.message || err}) — keeping existing snapshot`);
    }
  }
  if (failures === GROUPS.length) {
    console.error('All groups failed — is this host blocked by CelesTrak?');
    process.exit(1);
  }
  console.log(`Snapshot written to ${OUT_DIR}`);
}

main();
