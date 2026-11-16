// Smoke test for persistent profiles (v2.8.0: perch_start {persistProfile}).
//
// What it proves: localStorage (incl. the editor's "perchanceEditorClientId"
// agent identity) survives a full stop/start cycle on one profile dir, and a
// fresh non-persistent start does NOT carry it over.
//
// Run on the machine that hosts the server (needs node modules + a
// playwright browser):
//   node test/persist-profile.smoke.mjs [generatorName]
// //
// Exit 0 = all checks pass. Any failure prints FAIL + the reason and exits 1.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PerchSession } = require('../perch-core.js');

const NAME = process.argv[2] || 'minimal';
const MARK_KEY = '__perch_persist_probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(id, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + id + (detail ? ' — ' + detail : ''));
  if (!cond) failures++;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-profile-smoke-'));
  const s = new PerchSession();
  try {
    // 1) persistent start, write marker
    const marker = 'v1:' + Date.now();
    const r1 = await s.start({ name: NAME, persistProfile: true, profileDir: dir });
    check('persistent start ok', !!r1.ok, (r1.error || r1.step || '') + ' engine=' + (r1.effectiveEngine || r1.engine));
    check('start reports profile', !!(r1.profile && r1.profile.persistent === true && r1.profile.dir === dir), JSON.stringify(r1.profile || null));
    if (!r1.ok) throw new Error('cannot continue without a running session');
    await s.page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: MARK_KEY, v: marker });
    const back1 = await s.page.evaluate((k) => localStorage.getItem(k), MARK_KEY);
    check('marker written', back1 === marker);
    await s.stop();
    await sleep(1000);

    // 2) restart on the SAME dir: marker must survive (the actual persistence)
    const r2 = await s.start({ name: NAME, persistProfile: true, profileDir: dir });
    check('persistent restart ok', !!r2.ok, r2.error || r2.step || '');
    const back2 = r2.ok ? await s.page.evaluate((k) => localStorage.getItem(k), MARK_KEY) : null;
    check('marker survives restart', back2 === marker, 'got=' + JSON.stringify(back2));
    await s.stop();
    await sleep(1000);

    // 3) fresh non-persistent start: marker must be gone, profile reported off
    const r3 = await s.start({ name: NAME });
    check('fresh start ok', !!r3.ok, r3.error || r3.step || '');
    check('fresh start reports non-persistent', !!(r3.profile && r3.profile.persistent === false), JSON.stringify(r3.profile || null));
    const back3 = r3.ok ? await s.page.evaluate((k) => localStorage.getItem(k), MARK_KEY) : 'n/a';
    check('fresh profile is clean', back3 !== marker, 'got=' + JSON.stringify(back3));
    await s.stop();
  } catch (e) {
    console.log('FAIL exception: ' + (e && e.stack || e));
    failures++;
    try { await s.stop(); } catch {}
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try {
    const def = path.resolve('.perch-profile');
    if (fs.existsSync(def) && fs.readdirSync(def).length === 0) fs.rmdirSync(def);
  } catch {}
  console.log(failures === 0 ? 'ALL PERSISTENCE CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
