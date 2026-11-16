// perch-core.js — in-process Perchance editor controller.
//
// Lives inside the perch MCP server process (same model @playwright/mcp uses):
// no TCP daemon, no per-call spawn.
//
// Design notes:
//   * Preview-frame resolution. The running generator is the subframe
//     #outputIframeEl. Resolve it by iframe id, then by the perchance
//     subdomain URL, then by any live non-blank child frame. Never compare
//     an ElementHandle's `.id` — it is always undefined.
//   * Cloudflare: stealth launch args + init script, and a 4-step escalation
//     ladder (reuse ctx -> new ctx -> relaunch browser -> relaunch headed).
//     CF flagging is intermittent, so the ladder is what makes it reliable.
//   * Browser-free code access: `pull()` fetches modelText + outputTemplate
//     straight from the public API via curl (~1.2s, no CF risk) and writes
//     local mirror files, so reading/grepping code needs no browser at all.
//   * Diagnostics: console + pageerror buffers captured from every frame.
//   * UI testing by text: `snapshot()` lists interactive elements in the live
//     preview so an agent can drive the UI without screenshots.
//   * engine option: 'firefox' (DEFAULT — plain playwright firefox; clears
//     Cloudflare on perchance.org subdomains where chromium engines are
//     flagged) | 'chromium' (plain playwright chromium escape hatch, also the
//     automatic fallback when the firefox binary is unavailable).
//
// NOTE ON eval(): the `evaluate(...)` calls below are a browser JS-expression
// evaluator — that IS the feature (perch_eval / perch_type drive the live
// generator under test). The "eval_injection" lint hit is expected here.

const path = require('path');
const fs = require('fs');

// UA for the browser-free curl path only. The live browser path derives its
// UA from the actual binary version (see _launch) so the UA string can never
// contradict the client-hints headers the browser itself sends.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IDLE_MS = 20 * 60 * 1000;
const MIRROR_ROOT = path.join(__dirname, '.perch-mirror');
// ---------------- agent shelf (offline, browser-free) ----------------
// Mirrors the MCP Bridge generator's native shelf (its src/shelf.js): durable
// reasoning scratchpad, memory, todos, clock, calc and worker-style JS — all
// file-backed under .perch-shelf/ so an agent keeps continuity across the
// ~20 min browser idle-close, compaction, and even without perch_start.
const SHELF_DIR = path.join(__dirname, '.perch-shelf');
const SHELF_FILE = path.join(SHELF_DIR, 'shelf.json');

function _shelfLoad() {
  try {
    const raw = fs.readFileSync(SHELF_FILE, 'utf8');
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') throw new Error('bad shelf');
    if (!s.mem || typeof s.mem !== 'object') s.mem = {};
    if (!Array.isArray(s.thoughts)) s.thoughts = [];
    if (!Array.isArray(s.todos)) s.todos = [];
    return s;
  } catch (e) {
    return { mem: {}, thoughts: [], todos: [] };
  }
}
function _shelfSave(s) {
  fs.mkdirSync(SHELF_DIR, { recursive: true });
  fs.writeFileSync(SHELF_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function _stripHtml(html) {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return t.replace(/\s+/g, ' ').trim();
}

// Safe calculator (ports the bridge shelf's calcSafe): digit/operator input
// plus explicit Math.* aliases only — no variables, no function definitions.
function _calcSafe(e) {
  e = String(e || '');
  if (!/^[0-9+\-*/().,%\sA-Za-z^]*$/.test(e)) return { error: 'invalid characters (numbers, +-*/().,%,^ and Math names only)' };
  const alias = { sqrt: 'Math.sqrt', cbrt: 'Math.cbrt', sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan', asin: 'Math.asin', acos: 'Math.acos', atan: 'Math.atan', log: 'Math.log10', ln: 'Math.log', exp: 'Math.exp', abs: 'Math.abs', pow: 'Math.pow', floor: 'Math.floor', ceil: 'Math.ceil', round: 'Math.round', min: 'Math.min', max: 'Math.max', PI: 'Math.PI', E: 'Math.E' };
  const names = Object.keys(alias).sort((a, b) => b.length - a.length);
  for (const n of names) e = e.replace(new RegExp('\\b' + n + '\\b', 'g'), alias[n]);
  try {
    const v = Function('Math', 'return (' + e.replace(/\^/g, '**') + ')')(Math);
    if (typeof v !== 'number' || !isFinite(v)) return { error: 'not a finite number' };
    return { value: String(v) };
  } catch (err) { return { error: 'error: ' + err.message }; }
}

// STORE-method zip writer (no compression, no dependencies) — ports the
// bridge generator's DownloadsPlugin.makeZip CRC32 framing to Node Buffers.
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function _crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = _CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function _buildStoreZip(files) {
  // files: [{name, data: Buffer}]. Names stored as-is (flat or a/b paths).
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(String(f.name), 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data || ''), 'utf8');
    const crc = _crc32(data);
    const size = data.length;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    parts.push(lfh, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + size;
  }
  const cdBlob = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBlob.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBlob, eocd]);
}

// Static agent-skill catalog (mirrors the bridge generator's src/mcp/tools.js
// SKILLS: the same 13 plugin/skill ids). Served browser-free by perch_skills.
const SKILLS = [
  { id: 'ai-text-plugin', title: 'ai-text-plugin', description: 'Full reference for generateText: prompt options, image attachments, streaming, prefix-cache-friendly prompt design.' },
  { id: 'comments-plugin', title: 'comments-plugin', description: 'Embedded comments/chat/guestbook widgets: channels, styling, moderation, hooks, permissioned channels.' },
  { id: 'dynamic-metadata', title: 'dynamic-metadata', description: 'Query-aware $meta.dynamic(inputs) metadata for per-URL titles, descriptions, and social images.' },
  { id: 'kv-plugin', title: 'kv-plugin', description: 'Per-folder key/value persistence over IndexedDB; save/load, inventories, settings.' },
  { id: 'music-generation', title: 'music-generation', description: 'Using generate_music well: prompting, lyrics, wiring music into a generator.' },
  { id: 'opencode', title: 'opencode', description: 'OpenCode itself: config, MCP, plugins, SDK, troubleshooting — the harness connector target.' },
  { id: 'perchance-platform', title: 'perchance-platform', description: 'Deep reference for the Perchance engine and platform: DSL semantics, list-tree API, $meta, gotchas.' },
  { id: 'report', title: 'report', description: 'Collect diagnostics and publish an OpenCode issue with GitHub CLI.' },
  { id: 'secret-plugin', title: 'secret-plugin', description: 'Synchronous public-key encryption (ML-KEM): generateKeyPair, encrypt, decrypt.' },
  { id: 'server-plugin', title: 'server-plugin', description: 'Build realtime multiplayer/socket servers: createServerSocket, RPC, pub/sub, durable state, admin auth.' },
  { id: 'super-fetch-plugin', title: 'super-fetch-plugin', description: 'CORS-free fetch() drop-in for the generator at runtime.' },
  { id: 'text-to-image-plugin', title: 'text-to-image-plugin', description: 'Full reference for generateImage: prompt options, gallery, moderation.' },
  { id: 'upload-plugin', title: 'upload-plugin', description: 'Immutable/editable file uploads, temp-file limits, deletion, NSFW-check API.' },
];
// Locale/timezone are fingerprint inputs for the CF risk score; keep them
// consistent with the UA above and overridable by the caller.
const LOCALE = 'en-US';
const TIMEZONE = 'UTC';

// Reduce the automation fingerprint. Cloudflare scores navigator.webdriver +
// CDP artifacts; the init script handles the JS side, these flags the process.
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-default-browser-check',
  '--no-first-run',
  '--disable-infobars',
  '--disable-features=IsolateOrigins,site-per-process',
];

const STEALTH_INIT = () => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
  } catch (e) {}
};

// Standard playwright evaluate shape. Every evaluate that touches page globals
// goes through evalMain so the call shape has exactly one definition point.
function evalMain(target, fn, arg) {
  return target.evaluate(fn, arg);
}

// Default UA template per host OS (no fingerprint injection — this only
// exists to strip the "Headless" marker in headless mode, keeping the REAL
// browser version so UA and client hints always agree).
function platformUaPrefix() {
  switch (process.platform) {
    case 'darwin': return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
    case 'linux': return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)';
    default: return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)';
  }
}

// ---------------- engines ----------------
// One table, because a start can now walk ENGINES and not just steps: a browser that clears
// Cloudflare can still fail to boot the generator's PREVIEW (the platform's own "file loader"
// never arriving), and those two failures land on different engines.
//
//   firefox     plain playwright firefox        — default; clears perchance-subdomain CF
//   chrome      plain playwright chromium       — NO stealth args, NO init script (the control)
//   patchright  patchright's chromium           — drop-in playwright fork, patched CDP surface
//   chromium    playwright chromium + stealth   — the original escape hatch
//
// An engine must hand back a playwright-compatible Browser: this file drives pages, frames and
// evaluate() directly. That is also why the camofox-browser REST server cannot be an engine here
// — it exposes accessibility snapshots and clicks, not arbitrary JS in the page or its frames.
const ENGINES = {
  firefox:    { family: 'firefox',  stealth: false, label: 'playwright firefox' },
  chrome:     { family: 'chromium', stealth: false, label: 'playwright chromium, plain' },
  patchright: { family: 'chromium', stealth: false, label: 'patchright chromium' },
  chromium:   { family: 'chromium', stealth: true,  label: 'playwright chromium, stealth' },
};
// The order a start walks when it is asked for a chain — the engines that work first, and last the
// one that cannot read or write docs at all (kept because it is cheap to offer and the verdict may
// change with a platform update; see SKILL.md for the measured capability matrix).
//   firefox     the only engine that can ALSO use Perchance's server-side generation plugins
//               (ai-text replies / uploads) — those embeds are CF-flagged on chromium
//   chrome      plain chromium: clears CF headed, drives the editor + preview (no ai-text calls)
//   chromium    the same with the legacy stealth args
//   patchright  clears CF headed, but the platform's editor globals never publish -> cannot read
//               or write docs, so it is only reached once everything else has failed
const ENGINE_CHAIN = ['firefox', 'chrome', 'chromium', 'patchright'];

const _engineCache = {};
function loadChromium() {
  if (_engineCache.playwright) return _engineCache.playwright;
  const mod = require('playwright');
  _engineCache.playwright = { chromium: mod.chromium, firefox: mod.firefox };
  return _engineCache.playwright;
}
function loadPatchright() {
  if (_engineCache.patchright) return _engineCache.patchright;
  const mod = require('patchright');
  _engineCache.patchright = { chromium: mod.chromium };
  return _engineCache.patchright;
}

// Launch one engine. `effective` is what the caller reports back; it differs from the engine key
// only for the missing-firefox fallback (see _launch).
async function launchEngine(name, headed, width, height) {
  const spec = ENGINES[name];
  if (!spec) throw new Error('unknown engine "' + name + '" (have: ' + Object.keys(ENGINES).join(', ') + ')');
  const headless = !headed;
  if (name === 'patchright') {
    const pr = loadPatchright();
    return { browser: await pr.chromium.launch({ headless }), engine: name, effective: 'patchright' };
  }
  const pw = loadChromium();
  if (name === 'firefox') {
    if (!pw.firefox) throw new Error('playwright firefox binary missing — run `npx playwright install firefox`');
    return { browser: await pw.firefox.launch({ headless }), engine: name, effective: 'firefox' };
  }
  if (name === 'chrome') {
    return { browser: await pw.chromium.launch({ headless }), engine: name, effective: 'chrome' };
  }
  return { browser: await pw.chromium.launch({ headless, args: STEALTH_ARGS }), engine: name, effective: 'chromium' };
}

function buildEditorUrl(name, collabKey) {
  const base = `https://perchance.org/${name}`;
  return collabKey ? `${base}#edit:collab=${collabKey}` : `${base}#edit`;
}

// Detect a Cloudflare Turnstile / "Just a moment" interstitial.
// NOTE: do NOT match the bare word "cloudflare" in page text — perchance.org
// is behind Cloudflare and references it in its own HTML. Match the
// interstitial's structural signals instead.
async function isCfBlocked(page) {
  try {
    return await evalMain(page, () => {
      const t = (document.body && document.body.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      const hasTurnstile = document.querySelector(
        '#cf-turnstile, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]') !== null;
      return hasTurnstile ||
        title.includes('just a moment') ||
        t.includes('just a moment') ||
        t.includes('performing security verification') ||
        t.includes('verifying you are human') ||
        t.includes('checking your browser') ||
        t.includes('verify you are human');
    });
  } catch { return true; }
}

class PerchSession {
  constructor() {
    this.browser = null;
    this.ctx = null;
    this.page = null;
    this.generator = null;
    this.collabKey = null;
    this.headed = null;      // true = visible window
    this.engine = 'firefox';
    this.effectiveEngine = null; // what is actually running (engine / fallback)
    this._runningEngine = null;  // 'firefox' | 'chromium' — set by _launch
    this.ready = false;
    this.last = Date.now();
    this._idle = null;
    this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
  }

  _touch() { this.last = Date.now(); }

  _ensureIdle() {
    if (this._idle) return;
    this._idle = setInterval(() => {
      if (this.ctx && Date.now() - this.last > IDLE_MS) {
        this.stop().catch(() => {});
      }
    }, 30000);
    this._idle.unref();
  }

  // ---------------- diagnostics (console + runtime errors) ----------------
  _pushDiag(arr, droppedKey, entry, cap = 300) {
    arr.push(entry);
    if (arr.length > cap) { arr.shift(); this.diag[droppedKey]++; }
  }

  _attachDiagnostics(page) {
    this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    const push = (arr, droppedKey, entry, cap = 300) => this._pushDiag(arr, droppedKey, entry, cap);
    try {
      page.on('console', (msg) => {
        const type = msg.type();
        if (type === 'debug') return;
        const loc = msg.location() || {};
        push(this.diag.console, 'droppedConsole',
          `[${type}] ${msg.text()}${loc.url ? ' @ ' + String(loc.url).slice(-60) + ':' + loc.lineNumber : ''}`);
      });
      page.on('pageerror', (err) => {
        push(this.diag.errors, 'droppedErrors', (err && err.message) ? err.message : String(err));
      });
      page.on('requestfailed', (req) => {
        const url = req.url() || '';
        if (/\.(woff2?|png|jpe?g|svg|gif|ico)(\?|$)/i.test(url)) return;
        const f = req.failure();
        push(this.diag.console, 'droppedConsole', `[net-fail] ${url.slice(0, 120)} — ${f ? f.errorText : 'unknown'}`);
      });
    } catch (e) {}
  }

  async errors({ clear = false } = {}) {
    const syntax = this.page
      ? await evalMain(this.page, () => {
          try { return window.getEditorSyntaxErrors ? window.getEditorSyntaxErrors() : null; } catch (e) { return 'err:' + e.message; }
        }).catch(() => null)
      : null;
    // The editor surfaces generator runtime errors in its own error view (the user-facing
    // "An error has occurred somewhere in your code" panel). Those never reach the pane syntax
    // check and drown in console noise, so read the panel directly. Selectors are defensive:
    // the editor build changes its DOM without notice (window.yjsProvider already vanished).
    const errorView = this.page
      ? await evalMain(this.page, () => {
          try {
            const texts = [];
            const sels = ['.perchance-error-view', '[class*="error-view"]', '[class*="errorView"]',
                          '[id*="error-view"]', '[id*="errorView"]', '#errorView'];
            for (const s of sels) {
              for (const el of document.querySelectorAll(s)) {
                const t = String(el.innerText || '').trim();
                if (t) texts.push(t.slice(0, 2000));
              }
            }
            if (!texts.length && document.body) {
              const re = /error (?:has )?occurred somewhere|unhandled promise rejection/i;
              const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
              let n, guard = 0;
              while ((n = w.nextNode()) && guard++ < 3000) {
                const t = String(n.textContent || '');
                if (re.test(t) && t.length < 4000) { texts.push(t.replace(/\s+/g, ' ').slice(0, 2000)); break; }
              }
            }
            return texts;
          } catch (e) { return ['err:' + e.message]; }
        }).catch(() => null)
      : null;
    const out = {
      ok: true,
      syntaxErrors: syntax,
      errorView: errorView && errorView.length ? errorView : null,
      runtimeErrors: this.diag.errors.slice(-50),
      consoleTail: this.diag.console.slice(-50),
      droppedConsole: this.diag.droppedConsole,
      droppedErrors: this.diag.droppedErrors,
    };
    if (clear) this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    return out;
  }

  // Poll until the Yjs provider has flushed the pending edit to the server.
  async settle(timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      this._touch();
      let s = null;
      try {
        s = await evalMain(this.page, () => ({
          synced: !!(window.yjsProvider && window.yjsProvider.synced),
          save: window.perchanceSaveState || null,
        }));
      } catch { break; }
      if (s && s.synced && s.save !== 'saving') return true;
      await this.page.waitForTimeout(300);
    }
    return false;
  }

  // Resolve a target frame.
  //   'editor'  -> the Perchance editor page itself (chrome: editors, buttons)
  //   'preview' -> the running generator (the outputIframeEl subframe)
  //
  // v2 bug: `f.frameElement()` returns an ElementHandle, whose `.id` is always
  // undefined, so the id test never matched and the code fell through to the
  // LAST child frame — normally a chrome-error or about:blank frame.
  async _frame(which) {
    if (which === 'editor') return this.page;
    const frames = this.page.frames();
    for (const f of frames) {
      if (f === this.page.mainFrame()) continue;
      let id = null;
      try {
        const el = await f.frameElement();
        if (el) id = await el.getAttribute('id');
      } catch {}
      if (id === 'outputIframeEl') return f;
    }
    // 2) the preview runs on a per-user perchance subdomain
    for (const f of frames) {
      let url = '';
      try { url = f.url(); } catch {}
      if (/^https:\/\/[0-9a-f]{16,}\.perchance\.org\//.test(url)) return f;
    }
    // 3) last resort: any live, non-blank, non-console child frame
    const kids = frames.filter(f => {
      try {
        const u = f.url();
        return f.parentFrame() && u && u !== 'about:blank' &&
          !u.startsWith('chrome-error') && f.name() !== 'console-output';
      } catch { return false; }
    });
    if (kids.length) return kids[kids.length - 1];
    throw new Error('preview iframe not found (preview not loaded?)');
  }

  // Persistent profile (live-editor finding: the agent's identity lives in
  // localStorage "perchanceEditorClientId" — a fresh browser.newContext on
  // every start rotates it and wipes session history). With persistProfile,
  // the browser opens ONE user-data dir (launchPersistentContext), so the
  // client id, AI chat history and editor state survive restarts. The dir
  // defaults to .perch-profile under the server's working directory.
  async _openPersistent(width, height) {
    const name = this.engine || 'firefox';
    const headless = !this.headed;
    const viewport = { width, height };
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
    if (this.browser) { try { await this.browser.close(); } catch {} this.browser = null; }
    let ctx;
    if (name === 'patchright') {
      const pr = loadPatchright();
      ctx = await pr.chromium.launchPersistentContext(this.profileDir, { headless, viewport });
    } else {
      const pw = loadChromium();
      if (name === 'firefox') {
        if (!pw.firefox) throw new Error('playwright firefox binary missing — run `npx playwright install firefox`');
        ctx = await pw.firefox.launchPersistentContext(this.profileDir, { headless, viewport });
      } else {
        const spec = ENGINES[name] || ENGINES.chrome;
        ctx = await pw.chromium.launchPersistentContext(this.profileDir, {
          headless, viewport,
          args: spec.stealth ? STEALTH_ARGS : [],
          locale: LOCALE, timezoneId: TIMEZONE,
        });
        if (spec.stealth) await ctx.addInitScript(STEALTH_INIT);
      }
    }
    this._runningEngine = name;
    this.effectiveEngine = name;
    try { this.browser = (ctx.browser && ctx.browser()) || null; } catch { this.browser = null; }
    this.ctx = ctx;
    this._ensureIdle();
    return ctx;
  }

  async _newContext(width, height) {
    if (this.persistProfile && this.profileDir) return await this._openPersistent(width, height);
    const running = ENGINES[this._runningEngine] || ENGINES.firefox;
    const opts = { viewport: { width, height } };
    if (running.family === 'firefox' || !running.stealth) {
      // Bare context. Firefox carries no "Headless" UA marker and the native fingerprint cleared
      // the CF challenges; plain chromium ('chrome') is here to send exactly what an ordinary
      // browser sends, so it gets no UA rewrite, no locale override and no init script either.
      return this.browser.newContext(opts);
    }
    if (this.browser && this.headed === false) {
      // Headless default UA contains the "Headless" marker; replace it with
      // the real binary version (the old hardcoded version drifted from the
      // actual browser and contradicted the client-hint headers).
      const real = String(this.browser.version() || '');
      if (real) opts.userAgent = platformUaPrefix() + ' Chrome/' + real + ' Safari/537.36';
      else opts.userAgent = UA;
    }
    opts.locale = LOCALE;
    opts.timezoneId = TIMEZONE;
    const ctx = await this.browser.newContext(opts);
    await ctx.addInitScript(STEALTH_INIT);
    return ctx;
  }

  async _launch(headed, width, height) {
    // Persistent profile: skip the throwaway browser launch — the profile
    // dir IS the browser context (launchPersistentContext inside _newContext).
    if (this.persistProfile && this.profileDir) {
      this.engine = this.engine || 'firefox';
      return await this._newContext(width, height);
    }
    const want = this.engine || 'firefox';
    let r;
    try {
      r = await launchEngine(want, headed, width, height);
    } catch (e) {
      // The firefox binary is installed separately from the npm package, so keep the old grace
      // note: no binary means plain chromium rather than a failed start.
      if (want !== 'firefox') throw e;
      try { console.error('perch-mcp: playwright firefox unavailable (' + String((e && e.message) || e).slice(0, 140) + ') — falling back to chromium.'); } catch (e2) {}
      r = await launchEngine('chrome', headed, width, height);
      r.effective = 'chromium (firefox binary unavailable)';
    }
    this._runningEngine = r.engine;         // the engine KEY that is actually running
    this.effectiveEngine = r.effective;     // what gets reported (differs for the fallback above)
    this.browser = r.browser;
    this.ctx = await this._newContext(width, height);
    this._ensureIdle();
    return this.ctx;
  }

  // Make `name` the running engine: reuse it when it already is, else close what is running and
  // launch it. This is what lets a start() walk the engine chain instead of only re-trying steps
  // inside whichever browser it already had.
  async _ensureEngine(name, headed, width, height) {
    this.engine = name;
    if (this.browser && this._runningEngine === name) return;
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
    if (this.browser) { try { await this.browser.close(); } catch {} this.browser = null; }
    await this._launch(headed, width, height);
  }

  // Health of the generator PREVIEW (the frame the app actually runs in).
  //
  // The editor page can be perfectly healthy while the preview is dead: the platform's "file
  // loader" (root.loadDependencies, a script block of the page itself) sometimes never arrives
  // and the app never boots — the frame then shows "This generator could not start because its
  // file loader did not become available." Nothing used to look at the preview at all, so a
  // start could report ok:true while every perch_eval against it pended forever.
  //
  // Live/dead split (2026-11 revision): the platform renamed its app globals —
  // window.getAiProvider no longer exists, so the old `booted: typeof getAiProvider ===
  // 'function'` probe flagged EVERY healthy preview as dead, sent the ladder into relaunches
  // that ended on Cloudflare walls, and left sessions worse than it found them. The reliable
  // signals are the platform's OWN failure marker (the loader-error element, or its message
  // text) versus actual rendered generator content; the app global is kept only as a bonus
  // positive signal, never as the gate.
  async previewHealth() {
    if (!this.page) return { ok: true, running: false, hint: 'not started' };
    let frame;
    try { frame = await this._frame('preview'); }
    catch (e) { return { ok: true, found: false, note: 'no preview frame yet' }; }
    const read = () => evalMain(frame, () => {
      const errEl = document.querySelector('#perchance-src-loader-error');
      const bodyText = String((document.body && document.body.innerText) || '');
      const trimmed = bodyText.trim();
      const failedByText = /could not start because its file loader/i.test(bodyText);
      const appGlobal = typeof window.getAiProvider === 'function';
      const rendered = trimmed.length > 0 && !failedByText;
      return {
        loaderError: !!errEl || failedByText,
        loaderErrorText: errEl ? String(errEl.textContent || '').slice(0, 220) : null,
        appGlobal,
        rendered,
        booted: appGlobal || rendered,
        bootSignal: appGlobal ? 'getAiProvider' : (rendered ? 'rendered-content' : 'none'),
        text: bodyText.slice(0, 160),
      };
    });
    try {
      let r = await read();
      /* A frame caught mid-boot shows neither the failure marker nor content yet — grant a
         few increasing grace passes before calling it dead; the ladder treats "dead" as a
         reason to relaunch (which can end on a CF wall), so a premature verdict is the most
         expensive mistake this probe can make. Observed 2026-11-08: a cold-start preview
         stayed blank past a single 2s grace pass and triggered a needless 90s relaunch. */
      for (const wait of [1500, 3000, 5000]) {
        if (r.loaderError || r.rendered) break;
        await new Promise((res) => setTimeout(res, wait));
        r = await read();
      }
      return { ok: true, found: true, ...r, healthy: !!r.booted && !r.loaderError };
    } catch (e) {
      return { ok: true, found: true, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // Load the editor and wait until both docs are populated.
  // Returns { docsReady, cfBlocked, cfWaitedMs }.
  async _loadEditor(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let cfWaitedMs = 0;
    if (await isCfBlocked(page)) {
      // Turnstile can take 60-90s of "Waiting for token..." loops
      // before the challenge clears — 25s aborted a solve that was about to
      // succeed and sent the ladder into an endless relaunch cycle.
      const cfStart = Date.now();
      while (await isCfBlocked(page)) {
        if (Date.now() - cfStart > 90000) break;
        await page.waitForTimeout(2000);
      }
      cfWaitedMs = Date.now() - cfStart;
      if (await isCfBlocked(page)) return { docsReady: false, cfBlocked: true, cfWaitedMs };
      await page.waitForTimeout(2000);
    }
    await page.waitForFunction(() => {
      const w = window;
      if (w.__collabRoomFailed === true) return true;
      if (w.yjsProvider && w.yjsProvider.synced === true) return true;
      return false;
    }, null, { timeout: 45000 }).catch(() => {});
    await page.waitForFunction(() => window.outputTemplateEditor && window.modelTextEditor,
      null, { timeout: 25000 }).catch(() => {});
    const docsReady = async (timeoutMs) => {
      await page.waitForFunction(() => {
        const o = window.outputTemplateEditor, m = window.modelTextEditor;
        if (!o || !m) return false;
        return o.state.doc.length > 10 && m.state.doc.length > 10;
      }, null, { timeout: timeoutMs });
    };
    let ready = false;
    try { await docsReady(75000); ready = true; } catch { ready = false; }
    if (!ready) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      try { await docsReady(75000); ready = true; } catch { ready = false; }
    }
    await page.waitForTimeout(250);
    return { docsReady: ready, cfBlocked: false, cfWaitedMs };
  }

  // Load the editor, and hand back a preview that actually booted.
  //
  // Two ladders in one: the steps inside an engine (fresh context -> relaunch -> relaunch headed)
  // and, when an engine keeps producing a dead preview, the next engine in `engines`. The engine
  // switch is what a "file loader did not become available" preview needs — it is not a Cloudflare
  // block and no amount of re-trying the same browser fixes it.
  async _openWithLadder(url, { width, height, engines = null }) {
    const chain = (Array.isArray(engines) && engines.length ? engines : [this.engine || 'firefox']).slice();
    const attempts = [];
    let lastPreview = null;
    for (let ei = 0; ei < chain.length; ei++) {
      const engineName = chain[ei];
      const isLastEngine = ei === chain.length - 1;
      const steps = [
        { mode: 'newctx', headed: this.headed },
        { mode: 'relaunch', headed: this.headed },
      ];
      if (!this.headed) steps.push({ mode: 'relaunch', headed: true });
      for (const step of steps) {
        const label = engineName + ':' + step.mode + (step.headed ? '+headed' : '');
        const t0 = Date.now();
        try {
          if (step.mode === 'newctx' && this.browser && this._runningEngine === engineName && this.ctx) {
            // Same engine already up: a fresh context is the cheap first move.
            try { await this.ctx.close(); } catch {}
            this.ctx = await this._newContext(width, height);
          } else {
            this.headed = step.headed;
            await this._ensureEngine(engineName, step.headed, width, height);
            if (!this.ctx) this.ctx = await this._newContext(width, height);
          }
          this.page = await this.ctx.newPage();
          this._attachDiagnostics(this.page);
          const r = await this._loadEditor(this.page, url);
          const preview = r.docsReady ? await this.previewHealth() : null;
          if (preview) lastPreview = preview;
          attempts.push({
            step: label, engine: engineName, effectiveEngine: this.effectiveEngine,
            docsReady: r.docsReady, cfBlocked: r.cfBlocked,
            previewBooted: preview ? !!preview.booted : null,
            previewLoaderError: preview ? !!preview.loaderError : null,
            ms: Date.now() - t0,
          });
          if (r.docsReady && preview && preview.healthy) return { ok: true, attempts, step: label, preview };
          // Editor fine but the preview is dead: give the next engine a turn. Only the last
          // engine keeps spending its remaining steps (there is nowhere left to go).
          if (r.docsReady && !isLastEngine) break;
        } catch (e) {
          attempts.push({ step: label, engine: engineName, error: String((e && e.message) || e).slice(0, 180), ms: Date.now() - t0 });
        }
      }
    }
    const docsOk = attempts.some(a => a.docsReady);
    return { ok: docsOk, attempts, degraded: docsOk, preview: lastPreview };
  }

  // One-shot entry: launch (if needed) + load generator + collab key.
  async start({ name, collabKey = null, headed = false, width = 1500, height = 950, force = false, engine = null, engineChain = null, persistProfile = false, profileDir = null } = {}) {
    this._touch();
    const t0 = Date.now();
    if (!name) throw new Error('missing generator name');
    // Persistent profile keeps the editor's localStorage client id
    // ("perchanceEditorClientId") and AI chat history across restarts.
    const prevProfile = this.persistProfile ? this.profileDir : null;
    this.persistProfile = !!persistProfile;
    const envDir = (process.env.PERCH_PROFILE_DIR || '').trim();
    this.profileDir = this.persistProfile ? (profileDir || envDir || path.resolve('.perch-profile')) : null;
    const newProfile = this.persistProfile ? this.profileDir : null;
    if (engine) this.engine = engine; else this.engine = 'firefox'; // default: playwright firefox (clears perchance-subdomain CF challenges where chromium is flagged; falls back to chromium when the firefox binary is absent)
    // An explicit engine that differs from the RUNNING browser must take
    // effect: the ladder's 'newctx' step only recreates the context and would
    // otherwise silently keep the old engine (observed: engine:"chromium"
    // answered effectiveEngine:"patchright"). Force a relaunch in that case.
    if ((engine && this.browser && this._runningEngine && this._runningEngine !== this.engine) ||
        (this.browser && prevProfile !== newProfile)) {
      try { if (this.ctx) { await this.ctx.close(); } } catch {}
      try { await this.browser.close(); } catch {}
      this.ctx = null; this.browser = null; this.page = null; this.ready = false;
    }
    if (this.page && !force && this.ready && this.generator === name && this.collabKey === collabKey) {
      const s = await this.status();
      // Fall through to the ladder when the page is CF-blocked or the editor
      // views are gone — a plain re-call must actually escalate (fix: the old
      // fast path returned ok:true + cfBlocked:true forever, so the advertised
      // "call perch_start again" recovery never ran).
      if (!s.cfBlocked && s.hasOutputView && s.hasModelView) {
        return { ok: true, alreadyLoaded: true, ms: Date.now() - t0, ...s };
      }
    }
    this.headed = !!headed;
    const url = buildEditorUrl(name, collabKey);
    // The engine chain. An explicit array wins, `false` pins the one engine, and the DEFAULT walks
    // the recommended engines starting at the requested one — so a start that cannot load the editor,
    // or whose preview never boots, recovers by itself instead of leaving the caller with a dead
    // preview. A healthy start never leaves the first engine: the ladder returns as soon as the
    // preview is healthy, so the fallbacks cost nothing in the normal case.
    let chain = [this.engine];
    if (Array.isArray(engineChain) && engineChain.length) {
      chain = engineChain.slice();
    } else if (engineChain !== false) {
      const i = ENGINE_CHAIN.indexOf(this.engine);
      chain = i === -1 ? [this.engine] : ENGINE_CHAIN.slice(i);
    }
    // A typo'd or removed engine name must fail loudly. The ladder treats a launch failure as one
    // dead attempt and walks on, so without this an engine this build no longer ships (or a typo)
    // would silently start a different browser.
    const knownEngines = Object.keys(ENGINES);
    for (const e of chain) {
      if (!knownEngines.includes(e)) {
        throw new Error('unknown engine "' + e + '" (have: ' + knownEngines.join(', ') + ')');
      }
    }
    const r = await this._openWithLadder(url, { width, height, engines: chain });
    this.generator = name;
    this.collabKey = collabKey;
    if (!r.ok) {
      this.ready = false;
      return {
        ok: false, generator: name, collabKey, url, headed: this.headed, engine: this.engine,
        effectiveEngine: this.effectiveEngine || this.engine,
        ms: Date.now() - t0, cfBlocked: true, attempts: r.attempts,
        error: 'Cloudflare challenge not cleared after ' + r.attempts.length + ' attempt(s).',
        hint: 'CF flagging is intermittent — retry, or headed:true. The default firefox engine clears the subdomain challenges chromium cannot.',
      };
    }
    const st = await this.status();
    this.ready = !!(st.hasOutputView && st.hasModelView && !st.cfBlocked);
    const preview = r.preview || st.preview || null;
    const previewDead = !!(preview && preview.found && !preview.healthy);
    return {
      ok: true, generator: name, collabKey, url, headed: this.headed, engine: this.engine,
      effectiveEngine: this.effectiveEngine || this.engine,
      profile: this.persistProfile ? { persistent: true, dir: this.profileDir } : { persistent: false },
      docsReady: st.hasOutputView, recoveryStep: r.step, attempts: r.attempts, ms: Date.now() - t0,
      engineChain: chain,
      preview,
      ...(previewDead ? {
        previewDegraded: true,
        warning: 'The editor loaded but the generator preview did not boot (' +
          (preview.loaderError ? 'its file loader never arrived' : 'unknown reason') +
          '). Evaluations and UI tests against the preview will hang. Re-call perch_start with engineChain:[...] to try another engine — ' + ENGINE_CHAIN.join(' / ') + '.',
      } : {}),
      ...(this.ready ? {} : { warning: 'Editor docs not fully ready — try perch_start again.' }),
    };
  }

  async status() {
    if (!this.page) return { ok: true, running: false, engine: this.engine, hint: 'call perch_start first' };
    this._touch();
    const cfNow = await isCfBlocked(this.page);
    const pageState = await evalMain(this.page, () => {
      let syntaxErrors = null;
      try { syntaxErrors = window.getEditorSyntaxErrors ? window.getEditorSyntaxErrors() : null; } catch (e) {}
      return {
        saveState: window.perchanceSaveState || null,
        syntaxErrors,
        collabSynced: !!(window.yjsProvider && window.yjsProvider.synced),
        cmEditors: document.querySelectorAll('.cm-editor').length,
        hasModelView: !!window.modelTextEditor,
        hasOutputView: !!window.outputTemplateEditor,
        modelLines: window.modelTextEditor ? window.modelTextEditor.state.doc.toString().split('\n').length : null,
        outputLines: window.outputTemplateEditor ? window.outputTemplateEditor.state.doc.toString().split('\n').length : null,
      };
    }).catch(() => ({}));
    const result = {
      ok: true, running: true, generator: this.generator, collabKey: this.collabKey,
      headed: this.headed, engine: this.engine,
      effectiveEngine: this.effectiveEngine || this.engine,
      consoleBuffered: this.diag.console.length, errorsBuffered: this.diag.errors.length,
      ...pageState,
    };
    if (cfNow) {
      result.cfBlocked = true;
      result.warning = 'Cloudflare challenge is blocking the page. Call perch_start again (it escalates automatically).';
    }
    // The preview is the surface every perch_eval/perch_click against the running generator uses,
    // and it can be dead while the editor is fine — report its health on every status call.
    try { result.preview = await this.previewHealth(); } catch (e) {}
    return result;
  }

  // ---------------- browser-free code access ----------------
  _curlJson(url, body) {
    const { execFileSync } = require('child_process');
    const out = execFileSync('curl', [
      '-s', '-X', 'POST', url,
      '-H', 'Content-Type: application/json',
      '-H', 'Origin: https://perchance.org',
      '-H', 'Referer: https://perchance.org/' + (this.generator || ''),
      '-A', UA, '-d', body,
    ], { timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
    return JSON.parse(out);
  }
  _curlText(url) {
    const { execFileSync } = require('child_process');
    return execFileSync('curl', ['-s', '-A', UA, url],
      { timeout: 60000, maxBuffer: 256 * 1024 * 1024 }).toString();
  }

  // Fetch the raw generator payload (modelText + outputTemplate + srcManifest)
  // via the public API. NO browser, NO Cloudflare risk, ~1-2s.
  apiData({ name = null } = {}) {
    const gen = name || this.generator;
    if (!gen) throw new Error('no generator — pass name or call perch_start first');
    const data = this._curlJson('https://perchance.org/api/getGeneratorPageData',
      JSON.stringify({ generatorName: gen }));
    return (data && data.generator) || {};
  }

  // Write the authoritative source to local files for instant ripgrep/reading.
  pull({ name = null, dir = null } = {}) {
    const t0 = Date.now();
    const g = this.apiData({ name });
    const gen = name || this.generator;
    const out = dir || path.join(MIRROR_ROOT, gen);
    fs.mkdirSync(out, { recursive: true });
    const model = g.modelText || '';
    const html = g.outputTemplate || '';
    const modelPath = path.join(out, 'main.pjs');
    const htmlPath = path.join(out, 'index.html');
    fs.writeFileSync(modelPath, model, 'utf8');
    fs.writeFileSync(htmlPath, html, 'utf8');
    return {
      ok: true, generator: gen, dir: out, ms: Date.now() - t0,
      model: { path: modelPath, bytes: Buffer.byteLength(model), lines: model.split('\n').length },
      html: { path: htmlPath, bytes: Buffer.byteLength(html), lines: html.split('\n').length },
      srcManifestKeys: Object.keys(g.srcManifest || {}).length,
      hint: 'Grep/read these local files directly — no browser round-trip needed.',
    };
  }

  // ---------------- pane access (live editor) ----------------
  async read({ pane = 'output', offset = 1, limit = 2000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    return await evalMain(this.page, ({ pane, offset, limit }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'editor view not ready' };
      const all = v.state.doc.toString().split('\n');
      // Clamp the window and cap per-line length: a default 2000-line read of a
      // minified-ish pane once spilled ~120KB into the caller's context. Truncated
      // lines are marked so exact-text edit anchoring never silently lies.
      const start = Math.max(1, Math.min(Math.trunc(offset) || 1, all.length));
      const count = Math.max(1, Math.min(Math.trunc(limit) || 2000, all.length - start + 1, 5000));
      const MAX = 800;
      let linesTruncated = 0;
      const slice = [];
      for (let i = start - 1; i < start - 1 + count; i++) {
        const l = all[i];
        if (l.length > MAX) {
          linesTruncated++;
          slice.push(`${i + 1}|${l.slice(0, MAX)}…(+${l.length - MAX} chars)`);
        } else {
          slice.push(`${i + 1}|${l}`);
        }
      }
      return { ok: true, pane, totalLines: all.length, linesTruncated, lines: slice };
    }, { pane, offset, limit });
  }

  async grep({ pattern, pane = null, contextLines = 0, limit = 200 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    return await evalMain(this.page, ({ pattern, pane, contextLines, limit }) => {
      let re;
      try { re = new RegExp(pattern, 'gi'); } catch (e) { return { ok: false, error: 'bad regex: ' + e.message }; }
      const readOne = p => {
        const v = p === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
        return v ? v.state.doc.toString() : null;
      };
      const panes = pane ? [pane] : ['model', 'output'];
      const matches = [];
      let total = 0;
      for (const p of panes) {
        const text = readOne(p);
        if (text == null) continue;
        const lines = text.split('\n');
        lines.forEach((l, i) => {
          re.lastIndex = 0;
          if (!re.test(l)) return;
          total++;
          if (matches.length >= limit) return;
          const entry = { pane: p, line: i + 1, text: l.length > 400 ? l.slice(0, 400) + '…' : l };
          if (contextLines > 0) entry.context = lines.slice(Math.max(0, i - contextLines), i + contextLines + 1);
          matches.push(entry);
        });
      }
      return { ok: true, count: total, returned: matches.length, matches };
    }, { pattern, pane, contextLines, limit });
  }

  async edit({ pane = 'output', oldString, newString, replaceAll = false, settle = true, nth = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const res = await evalMain(this.page, ({ pane, oldString, newString, replaceAll, nth }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      if (v.state.doc.length === 0)
        return { ok: false, error: 'docs not ready (empty doc) — call perch_start again' };
      const doc = v.state.doc.toString();
      if (oldString.length === 0) return { ok: false, error: 'empty oldString' };
      const changes = []; let from = 0, count = 0, seen = 0;
      while (true) {
        const idx = doc.indexOf(oldString, from);
        if (idx === -1) break;
        seen++;
        if (nth == null || seen === nth) {
          changes.push({ from: idx, to: idx + oldString.length, insert: newString });
          count++;
          if (!replaceAll && nth == null) break;
        }
        from = idx + oldString.length;
      }
      if (count === 0)
        return { ok: false, error: nth != null ? `occurrence #${nth} not found (${seen} total)` : 'oldString not found', occurrences: seen };
      v.dispatch({ changes, userEvent: 'input.delete' });
      return { ok: true, replacements: count, occurrences: seen };
    }, { pane, oldString, newString, replaceAll, nth });
    if (res && res.ok && settle !== false) await this.settle();
    return res;
  }

  async write({ pane = 'output', content, settle = true } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const res = await evalMain(this.page, ({ pane, content }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, userEvent: 'input' });
      return { ok: true, chars: content.length };
    }, { pane, content });
    if (res && res.ok && settle !== false) await this.settle();
    return res;
  }

  // write_file: same dispatch as write(), but the content is read from a LOCAL file in this
  // server process. Exists because the large-document path has two hard walls write() hits:
  // a 2.6 MB outputTemplate does not fit through one MCP tool call, and fetching it from the
  // editor page is dead (perchance.org's CSP allows no connect-src to localhost). Byte-exact:
  // the file never passes through the conversation or the page's network stack.
  async writeFile({ pane = 'output', filePath, settle = true } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    if (!filePath) throw new Error('filePath is required');
    this._touch();
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return { ok: false, error: 'read failed: ' + String((e && e.message) || e), filePath };
    }
    const res = await evalMain(this.page, ({ pane, content }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      const before = v.state.doc.length;
      v.dispatch({ changes: { from: 0, to: before, insert: content }, userEvent: 'input' });
      return { ok: true, chars: content.length, lines: content.split('\n').length, before };
    }, { pane, content });
    if (res && res.ok && settle !== false) await this.settle();
    return Object.assign({ filePath, bytes: Buffer.byteLength(content, 'utf8') }, res || { ok: false, error: 'dispatch failed' });
  }

  async patch({ changes = [], settle = true } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const results = [];
    for (const c of changes) results.push(await this.edit({ ...c, settle: false }));
    if (settle !== false) await this.settle();
    const failed = results.filter(r => !r.ok).length;
    return { ok: failed === 0, applied: results.length - failed, failed, results };
  }

  async outline({ pane = 'output', limit = 400 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    return await evalMain(this.page, ({ pane, limit }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'editor view not ready' };
      const re = /^\s*(?:export\s+)?(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
      const lines = v.state.doc.toString().split('\n');
      const entries = [];
      lines.forEach((l, i) => {
        const m = l.match(re);
        if (m) entries.push({ line: i + 1, kind: m[1], name: m[2] });
      });
      return { ok: true, pane, count: entries.length, entries: entries.slice(0, limit) };
    }, { pane, limit });
  }

  async copyLines({ fromPane = 'output', startLine, endLine, toPane = null, afterLine = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const dest = toPane || fromPane;
    const fromDoc = await evalMain(this.page, p => {
      const v = p === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      return v ? v.state.doc.toString() : null;
    }, fromPane);
    if (fromDoc == null) return { ok: false, error: 'source pane not ready' };
    const fromLines = fromDoc.split('\n');
    const end = endLine || startLine;
    if (!startLine || startLine < 1 || end > fromLines.length)
      return { ok: false, error: 'line range out of bounds', totalLines: fromLines.length };
    const copied = fromLines.slice(startLine - 1, end);
    const toDoc = await evalMain(this.page, p => {
      const v = p === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      return v ? v.state.doc.toString() : null;
    }, dest);
    if (toDoc == null) return { ok: false, error: 'dest pane not ready' };
    const toLines = toDoc.split('\n');
    const after = afterLine == null ? toLines.length : afterLine;
    if (after < 0 || after > toLines.length) return { ok: false, error: 'afterLine out of bounds' };
    const newDoc = toLines.slice(0, after).concat(copied, toLines.slice(after)).join('\n');
    const res = await evalMain(this.page, ({ pane, content }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, userEvent: 'input' });
      return { ok: true };
    }, { pane: dest, content: newDoc });
    if (res && res.ok) await this.settle();
    return { ok: true, copied: copied.length, after, result: res };
  }

  // ---------------- preview: eval / refresh / console ----------------
  async eval({ js, frame = 'preview' } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const fr = await this._frame(frame);
    try {
      const res = await evalMain(fr, js);
      return { ok: true, frame, result: res };
    } catch (e) {
      return { ok: false, frame, error: String((e && e.message) || e).slice(0, 300) };
    }
  }

  async refresh() {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const before = this.diag.console.length;
    // Reload strategy (2026-11 revision): the navigational reloads (hardReloadOutputIframe,
    // editor.handleReloadButtonClick) send the preview iframe on a FRESH cross-subdomain
    // navigation, which Cloudflare punishes with an endless loader — and one hung preview
    // eval can wedge this single-threaded server for good (observed 2026-11-08). The
    // platform's own hot-update, editor.updateOutput(), pushes the room's current HTML into
    // the live preview IN PLACE (the same path typing uses): no navigation, no CF. It is
    // tier 1 now; the hard reload is only a fallback. Every preview eval is raced with a
    // short cap so nothing here can wedge the server again.
    const race = (p, ms) => Promise.race([Promise.resolve(p), new Promise((res) => setTimeout(() => res(undefined), ms))]);
    let via = 'update-output';
    const updated = await race(evalMain(this.page, () => {
      try {
        if (window.editor && typeof window.editor.updateOutput === 'function') {
          window.editor.updateOutput();
          return true;
        }
        return false;
      } catch (e) { return false; }
    }), 10000);
    if (updated !== true) {
      via = 'hard-reload';
      {
        const fr = await this._frame('preview').catch(() => null);
        if (fr) await race(evalMain(fr, () => { window.__perchReloadFlag = true; }), 3000).catch(() => {});
      }
      await race(evalMain(this.page, () => {
        try { if (window.hardReloadOutputIframe) window.hardReloadOutputIframe(); } catch (e) {}
      }), 5000);
    }
    const t0 = Date.now();
    let loaded = false;
    while (Date.now() - t0 < 25000) {
      const fr = await this._frame('preview').catch(() => null);
      if (fr) {
        const st = await race(evalMain(fr, () => ({ flag: !!window.__perchReloadFlag, rs: document.readyState })), 3000)
          .catch(() => null);
        if (st && !st.flag && st.rs === 'complete') { loaded = true; break; }
      }
      await this.page.waitForTimeout(400);
    }
    await this.page.waitForTimeout(700);
    const syntaxErrors = await race(evalMain(this.page, () => {
      try { return window.getEditorSyntaxErrors ? window.getEditorSyntaxErrors() : null; } catch (e) { return null; }
    }), 5000).catch(() => null);
    return {
      ok: true, via, previewLoaded: loaded, syntaxErrors,
      runtimeErrors: this.diag.errors.slice(-30),
      newConsoleLines: this.diag.console.slice(before).slice(-40),
      panel: await this._readConsole(),
    };
  }

  async console({ clear = false } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const out = {
      ok: true,
      panel: (await this._readConsole()).slice(-6000),
      buffered: this.diag.console.slice(-80),
      runtimeErrors: this.diag.errors.slice(-40),
    };
    if (clear) this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    return out;
  }

  async _readConsole() {
    for (const f of this.page.frames()) {
      if (f === this.page.mainFrame()) continue;
      try {
        if (f.name() === 'console-output')
          return await evalMain(f, () => document.body ? (document.body.innerText || document.body.textContent || '') : '');
      } catch {}
    }
    try {
      return await this.page.$eval('#console-output', el =>
        (el.contentDocument && el.contentDocument.body) ? (el.contentDocument.body.innerText || '') : '');
    } catch { return ''; }
  }

  // ---------------- UI testing (text-first) ----------------
  // List interactive elements in the live preview so an agent can drive the UI
  // without a screenshot. Each entry carries a CSS selector for perch_click.
  async snapshot({ frame = 'preview', limit = 250, filter = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const fr = await this._frame(frame);
    // NOTE: the callback below is serialized and runs IN THE BROWSER — only
    // the argument object is in scope there, so nothing outer may be closed
    // over (v3 first cut returned the outer `frame` here and threw).
    const out = await evalMain(fr, ({ limit, filter }) => {
      const cssPath = (el) => {
        if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
        const parts = [];
        let cur = el;
        for (let d = 0; cur && cur.nodeType === 1 && d < 4; d++) {
          if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
          let sel = cur.tagName.toLowerCase();
          const cls = (cur.className || '').toString().trim().split(/\s+/)
            .filter(c => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
          if (cls.length) sel += '.' + cls.join('.');
          const sibs = cur.parentNode ? [...cur.parentNode.children].filter(s => s.tagName === cur.tagName) : [];
          if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
          parts.unshift(sel);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      };
      const sel = 'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"]';
      const all = [...document.querySelectorAll(sel)];
      const out = [];
      for (const el of all) {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' &&
          style.display !== 'none' && style.opacity !== '0';
        if (!visible) continue;
        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value ||
          (el.innerText || el.textContent || '').trim() || el.getAttribute('title') || '')
          .replace(/\s+/g, ' ').slice(0, 80);
        if (filter && !(label + ' ' + el.tagName).toLowerCase().includes(filter.toLowerCase())) continue;
        out.push({
          tag: el.tagName.toLowerCase(), label,
          type: el.getAttribute('type') || undefined,
          id: el.id || undefined, disabled: el.disabled || undefined,
          selector: cssPath(el),
        });
        if (out.length >= limit) break;
      }
      return { ok: true, count: out.length, visibleCandidates: all.length, elements: out };
    }, { limit, filter });
    return { frame, ...out };
  }

  async wait({ selector = null, text = null, gone = false, frame = 'preview', timeout = 15000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const fr = await this._frame(frame);
    const t0 = Date.now();
    try {
      if (selector && selector.startsWith('text=')) { text = selector.slice(5); selector = null; }
      if (text != null) {
        const loc = fr.getByText(text, { exact: false }).first();
        await loc.waitFor({ state: gone ? 'detached' : 'visible', timeout });
      } else if (selector) {
        const loc = fr.locator(selector).first();
        await loc.waitFor({ state: gone ? 'detached' : 'visible', timeout });
      } else {
        await this.page.waitForTimeout(Math.min(timeout, 10000));
      }
      return { ok: true, waitedMs: Date.now() - t0, selector, text, gone };
    } catch (e) {
      return { ok: false, waitedMs: Date.now() - t0, error: String((e && e.message) || e).slice(0, 200), selector, text, gone };
    }
  }

  async click({ selector, frame = 'preview', timeout = 10000, nth = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!selector) throw new Error('missing selector');
    const fr = await this._frame(frame);
    const loc = selector.startsWith('text=')
      ? fr.getByText(selector.slice(5), { exact: false })
      : fr.locator(selector);
    const target = nth != null ? loc.nth(nth) : loc.first();
    try {
      await target.click({ timeout });
      return { ok: true, clicked: selector, frame, matches: await loc.count().catch(() => null) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200), matches: await loc.count().catch(() => 0) };
    }
  }

  // Real mouse hover (locator.hover): the only way CSS :hover engages — a JS .click()
  // dispatch or an eval cannot move the pointer, so hover-revealed controls (opacity
  // keyed to :hover, tooltips, menu bars) stay hidden no matter how they are "clicked".
  async hover({ selector, frame = 'preview', timeout = 10000, nth = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!selector) throw new Error('missing selector');
    const fr = await this._frame(frame);
    const loc = selector.startsWith('text=')
      ? fr.getByText(selector.slice(5), { exact: false })
      : fr.locator(selector);
    const target = nth != null ? loc.nth(nth) : loc.first();
    try {
      await target.hover({ timeout });
      return { ok: true, hovered: selector, frame, matches: await loc.count().catch(() => null) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200), matches: await loc.count().catch(() => 0) };
    }
  }

  async type({ selector, text, frame = 'preview', timeout = 10000, submit = false } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!selector) throw new Error('missing selector');
    const fr = await this._frame(frame);
    const loc = selector.startsWith('text=')
      ? fr.getByText(selector.slice(5), { exact: false }).first()
      : fr.locator(selector).first();
    try {
      await loc.fill(text, { timeout });
    } catch {
      await loc.click({ timeout });
      await loc.pressSequentially(text, { delay: 20 });
    }
    if (submit) await loc.press('Enter');
    return { ok: true, typed: text.length, frame, submitted: !!submit };
  }

  async press({ key, frame = 'editor' } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!key) throw new Error('missing key');
    // Keyboard lives on the page (frames have no .keyboard in this build).
    await this.page.keyboard.press(key);
    return { ok: true, pressed: key, frame };
  }

  async setViewport({ width = 1500, height = 950 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    await this.page.setViewportSize({ width, height });
    const rect = await evalMain(this.page, () => {
      const f = document.getElementById('outputIframeEl');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return { ok: true, viewport: { width, height }, iframe: rect };
  }

  async shot({ what = 'editor', path: p } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const out = p || path.join(__dirname, 'perch_shot.png');
    if (what === 'preview') {
      const el = await this.page.$('#outputIframeEl');
      if (el) await el.screenshot({ path: out });
      else {
        const frame = await this._frame('preview');
        if (typeof frame.screenshot === 'function') await frame.screenshot({ path: out });
        else throw new Error('cannot screenshot preview');
      }
    } else {
      await this.page.screenshot({ path: out, fullPage: false });
    }
    return { ok: true, what, path: out };
  }

  // ---------------- src/ access (via curl, passes CF) ----------------
  async _getManifest() {
    const data = this._curlJson('https://perchance.org/api/getGeneratorPageData',
      JSON.stringify({ generatorName: this.generator }));
    return (data.generator && data.generator.srcManifest) || {};
  }
  async src(p) {
    const manifest = await this._getManifest();
    const key = manifest[p] && manifest[p].key;
    if (!key) return { ok: false, error: 'src path not in manifest: ' + p, available: Object.keys(manifest) };
    const text = this._curlText('https://user.uploads.dev/file/' + key);
    return { ok: true, path: p, size: text.length, text: text.slice(0, 120000) };
  }
  async listSrc() {
    const manifest = await this._getManifest();
    const entries = Object.entries(manifest).map(([p, v]) => ({ path: p, size: v.size }));
    return { ok: true, count: entries.length, entries };
  }
  async fetchGenerator({ name, path: p } = {}) {
    if (!name) throw new Error('missing generator name');
    return this.pull({ name, dir: p ? path.dirname(p) : null });
  }

  // ---------------- top-level navigation (CF / preview recovery) ----------------
  // Navigates the whole editor PAGE (not just the preview iframe). Two uses:
  //  - recovering a session whose editor page got CF-challenged;
  //  - the subdomain-clearance recipe: a CF interstitial can never render
  //    inside an iframe, so a blocked embed (e.g. text-generation.perchance.org
  //    inside the ai-text-plugin) is cleared by visiting that URL top-level
  //    once, waiting out the challenge, then perch_start(force:true).
  async navigate({ url, timeout = 30000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!/^https:\/\//.test(url || '')) return { ok: false, error: 'only https:// URLs are allowed' };
    const t0 = Date.now();
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 60000) })
      .catch(e => ({ gotoError: String((e && e.message) || e).slice(0, 200) }));
    // Wait out a possible Cloudflare interstitial (auto-clearing JS challenge).
    let cf = true;
    while (Date.now() - t0 < timeout) {
      cf = await isCfBlocked(this.page);
      if (!cf) break;
      await this.page.waitForTimeout(1500);
    }
    const info = await evalMain(this.page, () => ({ url: location.href, title: document.title }))
      .catch(() => ({ url: null, title: null }));
    this.ready = false; // editor views are gone after leaving the editor page
    return {
      ok: !cf, cfBlocked: cf, elapsedMs: Date.now() - t0, ...info,
      note: cf ? 'challenge did not clear — retry, or open the URL once in a real browser'
               : 'navigated; call perch_start(force:true) to return to the editor',
    };
  }

  // ---------------- src/ upload + delete (proven against the live editor) ----------------
  // Uploads a file into the generator's src/ through the editor's file panel.
  // The src-tree uploader is <input data-ref="fileInput"> inside #aiAgentPanelEl;
  // #aiAgentFileInputEl is the AI-helper CHAT attachment input — do not confuse
  // them (attaching there does NOT create a src file).
  //
  // Names may carry virtual folders ('emoji/icon.svg'): the src store is a flat
  // string-keyed manifest, the tree groups '/' keys into folders, and the
  // editor's upload handler keeps the full path.
  // Re-uploading an existing path never overwrites: the editor RENAMES the
  // incoming file (name-2.ext) behind a modal notice. overwrite:true runs the
  // delete flow first — a staged delete clears the collision check, so the
  // re-upload lands on the exact same key (probed live).
  _validSrcName(name) {
    if (typeof name !== 'string' || !name.trim().length) return 'name is required';
    if (name !== name.trim()) return 'no leading/trailing whitespace';
    if (name.includes('\\')) return "use forward slashes: 'emoji/icon.svg'";
    if (name.startsWith('/') || name.endsWith('/')) return 'no leading/trailing slash';
    if (name.includes('//')) return 'empty path segment';
    const segs = name.split('/');
    if (segs.length > 8) return 'max 8 path segments';
    for (const seg of segs) {
      if (seg === '.' || seg === '..') return "dot segments are not allowed: '" + seg + "'";
      if (!/^[\w][\w .()-]{0,127}$/.test(seg)) return "segment '" + seg + "' may only hold letters/digits/_ . - ( ) and spaces, starting with a letter, digit or _";
      if (/[ .]$/.test(seg)) return "segment '" + seg + "' may not end with a space or dot";
    }
    if (name.length > 240) return 'path too long (max 240 chars)';
    return null;
  }

  async _ensureFilesPanel(ed) {
    // The helper chat view also contains the word "upload" (its 📤 button), so
    // check for the files view's actual markup instead: the src file input only
    // exists when the file tree is showing.
    const inputVisible = () => evalMain(ed, () => {
      const p = document.querySelector('#aiAgentPanelEl');
      return !!(p && p.querySelector('input[data-ref="fileInput"]'));
    }).catch(() => false);
    if (await inputVisible()) return true;
    try {
      await ed.locator('text=🗂 files').first().click({ timeout: 5000 });
    } catch { return false; }
    await this.page.waitForTimeout(700);
    return inputVisible();
  }

  _curlBuffer(url) {
    const { execFileSync } = require('child_process');
    return execFileSync('curl', ['-s', '-L', '-A', UA, url],
      { timeout: 120000, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });
  }

  // Resolve the upload source to exactly one of: inline content (small text only
  // — it transits the calling model's context), an absolute local filePath (read
  // server-side, byte-exact, nothing transits), or a https url (fetched
  // server-side). Binary-vs-text is decided by CONTENT (NUL-byte + strict-UTF-8
  // sniff) unless the caller forces `binary` — an extension whitelist would
  // send unknown binary types (.onnx, .safetensors, custom blobs) down the text
  // path, which UTF-8-expands their bytes (~1.77x) and corrupts them.
  _looksTextual(buf) {
    // Mirrors the editor's own looksLikeText() (srcFiles.js): a NUL byte in the
    // first 4KiB means binary; plus a strict UTF-8 decode of the WHOLE buffer —
    // any invalid sequence means binary. Text that survives both round-trips
    // losslessly either way, so a false 'textual' is harmless, while a false
    // 'binary' is not — which is why an extension list is not used here.
    if (buf.subarray(0, 4096).includes(0)) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; }
    catch (e) { return false; }
  }

  _readUploadSource({ content, filePath, url, binary }) {
    // content counts only when non-empty: the caller's cached tool schema may
    // still require a `content` argument, so `content: ""` + filePath/url is the
    // supported way to use a server-side source through an old client schema
    const given = [!!content, !!filePath, !!url].filter(Boolean).length;
    if (given === 0) return { error: 'one of content, filePath or url is required' };
    if (given > 1) return { error: 'pass only ONE of content, filePath or url' };
    // sha256 of the exact bytes being sent, plus sha256 of what the editor's
    // UTF-8 text fallback would store — uploadSrc uses these to classify a
    // landed upload as intact ('match') vs utf8-mangled (binary corrupted by
    // a UTF-8 text round-trip)
    const { createHash } = require('crypto');
    const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
    const mangledSha256 = (buf) => createHash('sha256').update(buf.toString('utf8'), 'utf8').digest('hex');
    let ext = '';
    if (filePath) {
      if (typeof filePath !== 'string' || !(/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('/'))) {
        return { error: 'filePath must be an ABSOLUTE path (the server process has no reliable working directory), e.g. C:/Users/you/Workspace/app/src/emoji/x.svg' };
      }
      const fs = require('fs');
      if (!fs.existsSync(filePath)) return { error: 'filePath does not exist: ' + filePath };
      ext = (filePath.split('.').pop() || '').toLowerCase();
      const buf = fs.readFileSync(filePath);
      const isBinary = binary != null ? !!binary : !this._looksTextual(buf);
      if (isBinary) return { base64: buf.toString('base64'), bytes: buf.length, ext, source: 'file', sha256: sha256(buf), mangledSha256: mangledSha256(buf) };
      return { text: buf.toString('utf8'), bytes: buf.length, ext, source: 'file', sha256: sha256(buf), mangledSha256: mangledSha256(buf) };
    }
    if (url) {
      if (!/^https?:\/\//i.test(url)) return { error: 'url must start with http(s)://' };
      try { ext = (new URL(url)).pathname.split('.').pop().toLowerCase(); } catch { ext = ''; }
      let buf;
      try { buf = this._curlBuffer(url); } catch (e) { return { error: 'url fetch failed: ' + e.message }; }
      if (!buf || !buf.length) return { error: 'url fetch returned an empty body: ' + url };
      const isBinary = binary != null ? !!binary : !this._looksTextual(buf);
      if (isBinary) return { base64: buf.toString('base64'), bytes: buf.length, ext, source: 'url', sha256: sha256(buf), mangledSha256: mangledSha256(buf) };
      return { text: buf.toString('utf8'), bytes: buf.length, ext, source: 'url', sha256: sha256(buf), mangledSha256: mangledSha256(buf) };
    }
    const text = String(content);
    const cbuf = Buffer.from(text, 'utf8');
    return { text, bytes: cbuf.length, ext: '', source: 'content', sha256: sha256(cbuf), mangledSha256: mangledSha256(cbuf) };
  }

  // Shared row-menu delete flow. Row matching is TEXT-anchored (the ⋯ button whose
  // small row contains the file name): published tree rows carry no span[title]
  // and their name spans include the 📄 prefix, so title/exact-text lookups miss
  // them. Returns {existed, deleted?, error?} — existed:false means no such row.
  async _deleteSrcRow(ed, path, { timeout = 20000 } = {}) {
    const findRow = (fnName) => evalMain(ed, ({ path }) => {
      const panel = document.querySelector('#aiAgentPanelEl');
      if (!panel) return { ok: false, error: 'files panel not found' };
      const fname = path.split('/').pop();
      // Anchor on the unique NAME LEAF (shortest childless element containing
      // the basename) and climb to its own row button. Matching any <160-char
      // ancestor container instead can select a SIBLING row's button when
      // several files share one container — this deleted the wrong file once.
      const leaves = [...panel.querySelectorAll('*')].filter(el =>
        el.childElementCount === 0 && (el.textContent || '').indexOf(fname) !== -1 && (el.textContent || '').length < 80);
      for (const nameEl of leaves.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)) {
        let n = nameEl;
        while (n && n !== panel) {
          if ([...n.querySelectorAll('button')].some(b => (b.title || '').indexOf('download / rename / delete') !== -1)) {
            return { ok: true, found: true };
          }
          n = n.parentElement;
        }
      }
      // not rendered: expand the first folder segment if the path has one
      const segs = path.split('/');
      if (segs.length > 1) {
        const folderSpan = [...panel.querySelectorAll('span')].find(el => (el.textContent || '').trim() === '▸ 📁 ' + segs[0]);
        if (folderSpan) { (folderSpan.closest('div') || folderSpan).click(); return { ok: true, found: false, expanded: true }; }
      }
      return { ok: true, found: false };
    }, { path }).catch(e => ({ ok: false, error: String(e && e.message || e) }));
    let probe = await findRow(path);
    if (!probe.ok) return { existed: false, error: probe.error };
    if (!probe.found) {
      if (probe.expanded) await this.page.waitForTimeout(900);
      probe = await findRow(path);
      if (!probe.ok) return { existed: false, error: probe.error };
      if (!probe.found) return { existed: false };
    }
    // open the row's ⋯ menu (name-leaf anchored — see findRow above)
    const menu = await evalMain(ed, ({ path }) => {
      const panel = document.querySelector('#aiAgentPanelEl');
      const fname = path.split('/').pop();
      const leaves = [...panel.querySelectorAll('*')].filter(el =>
        el.childElementCount === 0 && (el.textContent || '').indexOf(fname) !== -1 && (el.textContent || '').length < 80);
      for (const nameEl of leaves.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)) {
        let n = nameEl;
        while (n && n !== panel) {
          const btn = [...n.querySelectorAll('button')].find(b => (b.title || '').indexOf('download / rename / delete') !== -1);
          if (btn) { btn.click(); return { ok: true }; }
          n = n.parentElement;
        }
      }
      return { ok: false, error: 'row menu button (⋯) not found' };
    }, { path });
    if (!menu.ok) return { existed: true, error: menu.error };
    await this.page.waitForTimeout(700);
    // the menu is a document-level popup: childless div, exact "🗑️ delete".
    // Firefox needs a REAL pointer click on the item — the synthetic
    // el.click() closes the menu without triggering its handler (observed:
    // the confirm modal never appears), while playwright's click works.
    try {
      await ed.click('text=🗑️ delete', { timeout: 5000 });
    } catch (e) {
      return { existed: true, error: 'delete item not clickable (menu closed?)' };
    }
    await this.page.waitForTimeout(700);
    // confirm modal inside the panel ("Delete src/…?"), ok is its last button
    const confirm = await evalMain(ed, () => {
      const panel = document.querySelector('#aiAgentPanelEl');
      const overlays = [...panel.querySelectorAll('div')].filter(d => {
        const s = d.style || {};
        return s.position === 'absolute' && d.offsetParent !== null && (d.innerText || '').length > 0 && (d.innerText || '').length < 400;
      });
      const ov = overlays[overlays.length - 1];
      if (!ov || (ov.innerText || '').indexOf('Delete') === -1) return { ok: false, error: 'confirm modal not found' };
      const btns = [...ov.querySelectorAll('button')];
      const okBtn = btns.find(b => /^ok$/i.test((b.textContent || '').trim())) || btns[btns.length - 1];
      if (!okBtn) return { ok: false, error: 'confirm button not found' };
      okBtn.click();
      return { ok: true };
    });
    if (!confirm.ok) return { existed: true, error: confirm.error };
    // the staged delete removes the row at once — verify it is gone
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const gone = await evalMain(ed, ({ path }) => {
        const panel = document.querySelector('#aiAgentPanelEl');
        if (!panel) return { gone: false };
        const fname = path.split('/').pop();
        // gone = no name leaf whose row still carries a ⋯ button (a transient
        // status line mentioning the file must not block the check)
        const leaves = [...panel.querySelectorAll('*')].filter(el =>
          el.childElementCount === 0 && (el.textContent || '').indexOf(fname) !== -1 && (el.textContent || '').length < 80);
        for (const nameEl of leaves) {
          let n = nameEl;
          while (n && n !== panel) {
            if ([...n.querySelectorAll('button')].some(b => (b.title || '').indexOf('download / rename / delete') !== -1)) return { gone: false };
            n = n.parentElement;
          }
        }
        return { gone: true };
      }, { path }).catch(() => null);
      if (gone && gone.gone) return { existed: true, deleted: true };
      await this.page.waitForTimeout(800);
    }
    return { existed: true, deleted: false, error: 'row still present after confirm (check the editor and retry)' };
  }

  async deleteSrc({ path, timeout = 20000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const bad = this._validSrcName(path);
    if (bad) return { ok: false, error: bad };
    const ed = await this._frame('editor');
    if (!(await this._ensureFilesPanel(ed))) return { ok: false, error: 'could not open the files panel' };
    const r = await this._deleteSrcRow(ed, path, { timeout });
    if (!r.existed) return { ok: false, error: 'src path not in the file tree: ' + path };
    // store-level confirmation: the tree row can vanish while the room-synced
    // store still lists the path (or lists a {deleted:true} tombstone, which
    // counts as deleted). The registry settles a beat after the row disappears,
    // so poll briefly. null = store not observable (older editor build).
    let storeConfirmed = null;
    const scT0 = Date.now();
    while (Date.now() - scT0 < 6000) {
      const st = await evalMain(ed, ({ path }) => {
        const w = window.srcState && window.srcState._internals && window.srcState._internals.working;
        const e = w ? w[path] : null;
        // tombstones ({deleted:true}) live in the room registry YMap
        let y = null;
        try {
          const share = window.yjsProvider && window.yjsProvider.doc && window.yjsProvider.doc.share;
          const m = share && share.get && share.get('___pendingSrc___');
          if (m && m.get) y = m.get(path) || null;
        } catch (err) { /* older editor without the registry */ }
        if (!e && !y) return { present: false };
        return { present: true, deleted: !!((y && y.deleted) || (e && e.deleted)) };
      }, { path }).catch(() => null);
      if (st) {
        storeConfirmed = !st.present || st.deleted === true;
        if (storeConfirmed) break;
      }
      await this.page.waitForTimeout(800);
    }
    const deleted = !!r.deleted && storeConfirmed !== false;
    return {
      ok: deleted,
      deleted: !!r.deleted,
      storeConfirmed,
      path,
      error: r.error || (!r.deleted ? undefined
        : (storeConfirmed === false ? 'row removed from the tree but the editor src store still lists this path — re-check or retry' : undefined)),
      hint: deleted ? 'staged in the editor store; visitors see it once the generator owner saves' : undefined,
    };
  }

  async uploadSrc({ name, content, filePath, url, binary, timeout = 25000, overwrite = false } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const bad = this._validSrcName(name);
    if (bad) return { ok: false, error: bad };
    const src = this._readUploadSource({ content, filePath, url, binary });
    if (src.error) return { ok: false, error: src.error };
    if (src.bytes > 64 * 1024 * 1024) return { ok: false, error: 'file too large for the panel uploader (>64MB): ' + src.bytes + ' bytes' };
    const ed = await this._frame('editor');
    if (!(await this._ensureFilesPanel(ed))) return { ok: false, error: 'could not open the files panel' };
    // Baseline BEFORE any delete/write: what the room currently holds for this
    // name. The wait loop below ignores entries matching this baseline — a fresh
    // tab still sees the PREVIOUS session's published entry (old hash) until this
    // tab's own publish lands, and a same-bytes re-upload keeps the hash and only
    // bumps the rev, so either alone would misclassify the landing.
    const readStoreEntry = () => evalMain(ed, ({ name }) => {
      try {
        const w = window.srcState && window.srcState._internals && window.srcState._internals.working;
        const e = w ? w[name] : null;
        let y = null;
        try {
          const share = window.yjsProvider && window.yjsProvider.doc && window.yjsProvider.doc.share;
          const m = share && share.get && share.get('___pendingSrc___');
          if (m && m.get) y = m.get(name) || null;
        } catch (err2) { /* older editor without the registry */ }
        const entry = y || e;
        if (!entry) return null;
        return {
          deleted: !!(entry.deleted || (e && e.deleted)),
          size: (entry.size !== undefined ? entry.size : (e ? e.size : null)),
          hash: (y && y.hash) || null,
          rev: entry.rev || null,
        };
      } catch (err) { return null; }
    }, { name }).catch(() => null);
    const baseline = await readStoreEntry();
    // Overwrite = delete the existing entry first (see the header comment).
    let overwrote = false;
    if (overwrite) {
      const del = await this._deleteSrcRow(ed, name);
      if (del.existed && !del.deleted) {
        return { ok: false, error: 'could not delete the existing file before overwrite' + (del.error ? ': ' + del.error : '') };
      }
      overwrote = !!del.existed;
    }
    // inject the file via DataTransfer (callback runs IN THE BROWSER); binary
    // arrives base64-encoded and is decoded to real bytes page-side
    const r = await evalMain(ed, ({ name, content, base64 }) => {
      const input = document.querySelector('#aiAgentPanelEl input[data-ref="fileInput"]');
      if (!input) return { ok: false, error: 'src file input not found — open the files panel first' };
      const ext = (name.split('.').pop() || '').toLowerCase();
      const mime = { md: 'text/markdown', txt: 'text/plain', js: 'text/javascript', mjs: 'text/javascript',
        json: 'application/json', html: 'text/html', css: 'text/css', svg: 'image/svg+xml',
        xml: 'application/xml', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
        woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
        zip: 'application/zip', pdf: 'application/pdf', wasm: 'application/wasm' }[ext] || (base64 ? 'application/octet-stream' : 'text/plain');
      let payload = content;
      if (base64) {
        const bin = atob(content);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        payload = u8;
      }
      const dt = new DataTransfer();
      dt.items.add(new File([payload], name, { type: mime }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }, { name, content: src.base64 || src.text, base64: !!src.base64 });
    if (!r.ok) return r;
    // Wait for the upload to land. The panel's innerText "saved" marker is
    // NOT authoritative: folder-path rows render the basename only (the full
    // path never appears in the text), and a fresh tab can show the previous
    // session's state. Authoritative signal: the room-synced store entry —
    // window.srcState._internals.working[name] plus the sha256-carrying
    // ___pendingSrc___ registry entry — REFRESHED relative to the baseline.
    const t0 = Date.now();
    let saved = false;
    let renamedTo = null;
    let storeInfo = null;
    let savedAt = 0;
    while (Date.now() - t0 < timeout) {
      const state = await evalMain(ed, ({ name }) => {
        const panel = document.querySelector('#aiAgentPanelEl');
        const txt = panel ? (panel.innerText || '') : '';
        let renamed = null;
        const overlays = [...panel.querySelectorAll('div')].filter(d => {
          const s = d.style || {};
          return s.position === 'absolute' && d.offsetParent !== null && (d.innerText || '').indexOf('were renamed') !== -1;
        });
        const ov = overlays[overlays.length - 1];
        if (ov) {
          const m = (ov.innerText || '').match(/([\w./-]+)\s+→\s+([\w./-]+)/);
          if (m) renamed = m[2];
          const okBtn = [...ov.querySelectorAll('button')].pop();
          if (okBtn) okBtn.click(); // dismiss so later calls are not blocked
        }
        let store = null;
        try {
          const w = window.srcState && window.srcState._internals && window.srcState._internals.working;
          const e = w ? w[name] : null;
          // the sha256 lives in the room registry YMap, not in working[]
          let y = null;
          try {
            const share = window.yjsProvider && window.yjsProvider.doc && window.yjsProvider.doc.share;
            const m = share && share.get && share.get('___pendingSrc___');
            if (m && m.get) y = m.get(name) || null;
          } catch (err2) { /* older editor without the registry */ }
          const entry = y || e;
          if (entry) store = {
            deleted: !!(entry.deleted || (e && e.deleted)),
            committed: !!(y && y.committed),
            size: (entry.size !== undefined ? entry.size : (e ? e.size : null)),
            hash: (y && y.hash) || null,
            rev: entry.rev || null,
          };
        } catch (err) { /* best-effort probe */ }
        return { txt, renamed, store };
      }, { name }).catch(() => null);
      if (state && state.renamed) { renamedTo = state.renamed; break; }
      if (state && state.store && !state.store.deleted) {
        // fresh = differs from the pre-upload baseline (rev preferred — a
        // same-bytes re-upload keeps the hash but bumps the rev; hash fallback
        // for builds whose entries carry no rev; neither → treat as fresh)
        const fresh = !baseline || (state.store.rev && baseline.rev
          ? state.store.rev !== baseline.rev
          : (baseline.hash && state.store.hash ? state.store.hash !== baseline.hash : true));
        if (fresh) {
          storeInfo = state.store;
          if (state.store.hash) break; // complete entry — classify integrity
        }
      }
      if (state && state.txt.includes(name) && /saved/i.test(state.txt)) {
        saved = true;
        // the room-registry entry (carrying sha256) can lag the panel marker
        // by a beat — keep polling a few more seconds so integrity gets
        // classified instead of reporting an unverified landing
        if (!savedAt) savedAt = Date.now();
        else if (Date.now() - savedAt > 6000) break;
      }
      await this.page.waitForTimeout(800);
    }
    // integrity: what the room actually holds vs the exact bytes injected.
    // 'utf8-mangled' = the panel's text fallback stored the file through a
    // UTF-8 decode, which corrupts binary files (text files round-trip
    // losslessly, so their hash still matches the source).
    let integrity = 'unknown';
    if (storeInfo && src.sha256) {
      if (storeInfo.hash === src.sha256) integrity = 'match';
      else if (src.mangledSha256 && storeInfo.hash === src.mangledSha256) integrity = 'utf8-mangled';
    }
    const landed = !!storeInfo;
    const mangled = integrity === 'utf8-mangled';
    const embedBlocked = this.diag.console.some(l => String(l).indexOf('upload.perchance.org') !== -1 &&
      (String(l).indexOf('ERR_BLOCKED') !== -1 || String(l).indexOf('X-Frame-Options') !== -1));
    return {
      ok: !mangled && (landed || saved),
      file: name, saved, landed, integrity,
      overwritten: overwrote, renamedTo, ms: Date.now() - t0,
      bytes: src.bytes, source: src.source,
      sha256: src.sha256 || null,
      storeHash: storeInfo ? storeInfo.hash : null,
      storeSize: storeInfo ? storeInfo.size : null,
      embedBlocked,
      error: renamedTo
        ? 'the editor renamed the upload because the name already exists — it landed at ' + renamedTo + '; retry with overwrite:true to replace the original'
        : (mangled
          ? 'landed in the editor src store but the bytes are CORRUPTED (integrity utf8-mangled): the file went through UTF-8 text storage, which expands/corrupts binary data (stored ' + storeInfo.size + ' bytes vs source ' + src.bytes + '). Usual cause: binary:false was forced on a non-UTF-8 file. Retry with overwrite:true and no binary flag — content sniffing picks the byte-exact path.'
          : undefined),
      hint: mangled
        ? 'do not treat this file as uploaded — the staged bytes do not match the source'
        : (landed
          ? 'landed in the editor src store (integrity: ' + integrity + '); visitors see it once the generator owner saves'
          : (saved
            ? 'panel reported "saved" but no store entry was observed — verify with perch_eval {frame:"editor", js:"JSON.stringify(window.srcState._internals.working)"}'
            : (renamedTo ? undefined : 'file was injected but never landed in the editor src store and the panel never reported "saved" — check perch_errors and retry'))),
    };
  }

  // ---------------- built-in AI helper (chatbox bridge) ----------------
  // The editor's integrated AI coding agent has no API — only its chatbox:
  //   <textarea id="aiAgentInputEl"> + <button id="aiAgentSendBtn">Send</button>
  // inside #aiAgentPanelEl. These methods let ANY outside coding agent drive it
  // over MCP: wake/ensure the chat view, send text, and harvest the reply.
  //
  // #aiAgentPanelEl is a SHARED side panel: the "files" view (input
  //[data-ref="fileInput"]) and the AI chat view (input #aiAgentInputEl) replace
  // each other. After perch_upload_src / perch_delete_src ran, the panel is
  // sitting on the files view and the chatbox is simply not rendered — the
  // wake step clicks back to the AI view. Probe-then-click, never blind.
  // Central wake/send tuning, validated against a faithful in-browser
  // simulator of the panel (chatbox + send button + strict controlled-mode
  // framework + busy agent): 10/10 green x3 runs, triple-click race = 1 send.
  // every aiAsk/aiWake parameter still overrides its own default.
  static AI_WAKE = {
    ensurePanelMs: 15000,  // _ensureAiPanel budget (tab-click retries)
    fillTimeoutMs: 15000,  // locator.fill budget
    seqDelayMs: 5,         // pressSequentially inter-key delay
    seqTimeoutMs: 60000,   // pressSequentially budget (12k chars)
    maxChars: 12000,       // chatbox send cap — split bigger jobs
    sendConfirmMs: 12000,  // send-accepted confirmation window
    enterFallbackAtMs: 4000, // no confirm by now -> try Enter key once
    pollMs: 1000,          // reply-poll interval
    stableMs: 2500,        // reply text must stop changing this long
    waitIdleMs: 30000,     // pre-send busy-wait cap
    askTimeoutMs: 180000,  // default reply wait
  };
  async _aiProbe(ed) {
    return await evalMain(ed, () => {
      const q = (s) => { try { return document.querySelector(s); } catch (e) { return null; } };
      const panel = q('#aiAgentPanelEl');
      const input = q('#aiAgentInputEl');
      const send = q('#aiAgentSendBtn');
      const vis = (el) => {
        if (!el) return false;
        try {
          if (el.hidden) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) return false;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
          return true;
        } catch (e) { return false; }
      };
      const panelText = panel ? String(panel.innerText || '') : '';
      const busyRe = /thinking|generating|working on it|running|one moment|please wait|typing\.\.\.|stop\b/i;
      let spinner = false;
      try {
        if (panel) {
          spinner = !!panel.querySelector(
            '.spinner, .loader, .loading, [class*="spinner"], [class*="loading"], [class*="thinking"], [aria-busy="true"]');
        }
      } catch (e) {}
      // Message + location signals (additive: aiWake/aiRead ignore the extras).
      // The bridge's chat.* probe tracks the same three for its status pill.
      let messageCount = 0;
      try {
        if (panel) {
          const seen = new Set();
          for (const s of ['[class*="message"]', '[class*="chat"]', '[class*="reply"]', '[class*="assistant"]', '[class*="conversation"]', '[class*="thread"]']) {
            try {
              for (const el of panel.querySelectorAll(s)) {
                if (!seen.has(el)) { seen.add(el); messageCount++; }
              }
            } catch (e2) {}
          }
        }
      } catch (e) {}
      let url = '', generatorName = '';
      try {
        url = location.href || '';
        generatorName = (location.pathname || '').split('/').filter(Boolean).pop() || '';
      } catch (e) {}
      return {
        panelExists: !!panel,
        inputExists: !!input,
        sendExists: !!send,
        panelVisible: vis(panel),
        inputVisible: vis(input),
        sendVisible: vis(send),
        inputEnabled: !!(input && !input.disabled && !input.readOnly),
        sendEnabled: !!(send && !send.disabled && vis(send)),
        sendDisabled: !!(send && send.disabled),
        inputValueLen: input && typeof input.value === 'string' ? input.value.length : null,
        panelTextLen: panelText.length,
        busyHint: spinner || busyRe.test(panelText.slice(-1500)),
        messageCount, url, generatorName,
      };
    }).catch((e) => ({ probeError: String((e && e.message) || e) }));
  }

  // Ensure the AI chat view (not the files view) is showing and the chatbox
  // is visible + enabled. Clicks AI-view tabs until #aiAgentInputEl appears.
  async _ensureAiPanel(ed, timeoutMs = PerchSession.AI_WAKE.ensurePanelMs) {
    const t0 = Date.now();
    const clicked = [];
    // Lazy injection (live-editor finding: aiAgentClient.js loads lazily and
    // injects the panel into #appEl after load) — wait for the composer to
    // EXIST before spending the tab-click budget. Resolves instantly when the
    // UI is already there; the MutationObserver-free waitForFunction covers
    // both the slow-script and the already-rendered cases.
    try {
      await ed.waitForFunction(() => !!document.querySelector('#aiAgentInputEl'), null, { timeout: Math.min(10000, Math.max(1000, timeoutMs)) });
    } catch (e) {}
    let probe = await this._aiProbe(ed);
    if (probe.inputVisible && probe.sendVisible) {
      return { ok: true, alreadyAwake: true, probe, clicked, ms: Date.now() - t0 };
    }
    // Candidate tab/button labels that switch the shared panel back to chat.
    // Ordered: most specific first. Matched case-insensitively against the
    // button's own text + aria-label + title (NOT panel-wide innerText, which
    // always contains chat history and would match everything).
    while (Date.now() - t0 < timeoutMs) {
      const next = await evalMain(ed, ({ already }) => {
        const panel = document.querySelector('#aiAgentPanelEl');
        const cands = [...document.querySelectorAll(
          '#aiAgentPanelEl button, #aiAgentPanelEl [role="tab"], #aiAgentPanelEl [role="button"], ' +
          'button, [role="tab"]')];
        const seen = new Set(already);
        const scoreOf = (t) => {
          const s = String(t || '').toLowerCase().trim();
          if (!s) return -1;
          if (/^ai (helper|agent|chat)$/.test(s)) return 100;
          if (/ai helper|ai agent|ai chat/.test(s)) return 90;
          if (/^assistant$/.test(s)) return 80;
          if (/^ai$/.test(s)) return 70;
          if (/helper|assistant/.test(s)) return 60;
          if (/🤖|✨/.test(s)) return 50;
          if (/\bai\b/.test(s)) return 40;
          return -1;
        };
        let best = null, bestScore = -1;
        for (const b of cands) {
          const lab = ((b.getAttribute && (b.getAttribute('aria-label') || b.getAttribute('title'))) || '') + ' ' + (b.innerText || b.textContent || '');
          const key = (b.tagName || '') + '|' + lab.slice(0, 60);
          if (seen.has(key)) continue;
          const sc = scoreOf(lab);
          if (sc > bestScore) { bestScore = sc; best = { key, label: lab.slice(0, 80) }; }
        }
        if (!best || bestScore < 0) {
          // No labelled tab: the panel itself may be collapsed — look for its
          // toggle by id/class as a last resort.
          const tgl = document.querySelector('[id*="aiAgent"], [class*="aiAgent"]');
          if (tgl && !already.includes('__paneltoggle__')) {
            try { tgl.click(); } catch (e) {}
            return { clicked: '__paneltoggle__', label: (tgl.tagName || '') };
          }
          return { clicked: null };
        }
        // Click the best candidate via real .click() (panel tabs are plain DOM).
        for (const b of cands) {
          const lab = ((b.getAttribute && (b.getAttribute('aria-label') || b.getAttribute('title'))) || '') + ' ' + (b.innerText || b.textContent || '');
          const key = (b.tagName || '') + '|' + lab.slice(0, 60);
          if (key === best.key) { try { b.click(); } catch (e) {} break; }
        }
        return { clicked: best.key, label: best.label };
      }, { already: clicked }).catch(() => ({ clicked: null }));
      if (next && next.clicked) clicked.push(next.clicked);
      await this.page.waitForTimeout(800);
      probe = await this._aiProbe(ed);
      if (probe.inputVisible && probe.sendVisible) {
        return { ok: true, alreadyAwake: false, probe, clicked, ms: Date.now() - t0 };
      }
      if (!next || !next.clicked) break; // nothing left to try
      if (clicked.length > 10) break;
    }
    probe = await this._aiProbe(ed);
    const ok = !!(probe.inputVisible && probe.sendVisible);
    return {
      ok, alreadyAwake: false, probe, clicked, ms: Date.now() - t0,
      ...(ok ? {} : { error: 'AI chatbox not visible after ' + clicked.length + ' toggle click(s). The shared #aiAgentPanelEl may be on the files view or an unknown editor build moved the tabs — snapshot the editor frame and look for the AI tab.' }),
    };
  }

  // Read the conversation transcript out of the panel DOM. Heuristic on
  // purpose: the editor build renames its classes without notice, so anchor
  // on role-ish attributes/classes first and fall back to text blocks.
  async _readAiTranscript(ed, limit = 20) {
    return await evalMain(ed, ({ limit }) => {
      const panel = document.querySelector('#aiAgentPanelEl');
      if (!panel) return { ok: false, error: 'panel #aiAgentPanelEl not found', messages: [] };
      const msgs = [];
      const seen = new Set();
      const push = (role, text) => {
        text = String(text || '').replace(/\s+\n/g, '\n').trim();
        if (!text || text.length < 1) return;
        if (text.length > 8000) text = text.slice(0, 8000) + '…(+truncated)';
        const k = role + '|' + text.slice(0, 120);
        if (seen.has(k)) return;
        seen.add(k);
        msgs.push({ role, text });
      };
      const guessRole = (el) => {
        let hay = '';
        try {
          const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
          const id = typeof el.id === 'string' ? el.id : '';
          let attr = '';
          if (el.getAttribute) {
            attr = el.getAttribute('data-role') || el.getAttribute('data-author') || el.getAttribute('data-type') || '';
          }
          hay = (cls + ' ' + id + ' ' + attr).toLowerCase();
        } catch (e) { hay = ''; }
        if (/user|you|human|prompt/.test(hay)) return 'user';
        if (/ai|assistant|agent|bot|response|answer/.test(hay)) return 'assistant';
        return 'unknown';
      };
      // 1) explicit message-ish nodes
      try {
        const nodes = panel.querySelectorAll(
          '[data-message], [data-role], [data-author], .message, .chat-message, .msg, ' +
          '[class*="message"], [class*="chat-bubble"], [class*="bubble"], [class*="user-message"], [class*="ai-message"]');
        for (const n of nodes) {
          if (n.querySelector && n.querySelector('#aiAgentInputEl, #aiAgentSendBtn, input, textarea')) continue;
          const t = (n.innerText || n.textContent || '').trim();
          if (t.length < 2 || t.length > 12000) continue;
          if (/^send$/i.test(t)) continue;
          push(guessRole(n), t);
        }
      } catch (e) {}
      // 2) fallback: direct child blocks with real text (skip toolbar/input rows)
      if (!msgs.length) {
        try {
          const kids = [...panel.querySelectorAll('div')].filter(d =>
            d.childElementCount <= 3 &&
            !d.querySelector('#aiAgentInputEl, #aiAgentSendBtn, input[data-ref="fileInput"]'));
          for (const d of kids) {
            const t = (d.innerText || '').trim();
            if (t.length < 20 || t.length > 6000) continue;
            if (/files|upload|drag & drop/i.test(t) && t.length < 200) continue;
            push(guessRole(d), t);
          }
        } catch (e) {}
      }
      const raw = String(panel.innerText || '');
      const tail = msgs.slice(-Math.max(1, Math.min(limit || 20, 100)));
      return { ok: true, count: msgs.length, messages: tail, rawTail: raw.slice(-6000), rawLen: raw.length };
    }, { limit }).catch((e) => ({ ok: false, error: String((e && e.message) || e), messages: [] }));
  }

  // Wake-only: make the chatbox visible and report readiness + recent lines.
  async aiWake({ timeout = 15000, limit = 10 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const ed = await this._frame('editor');
    const wake = await this._ensureAiPanel(ed, timeout);
    const transcript = await this._readAiTranscript(ed, limit);
    return {
      ok: wake.ok, alreadyAwake: wake.alreadyAwake,
      inputVisible: wake.probe && wake.probe.inputVisible,
      sendVisible: wake.probe && wake.probe.sendVisible,
      sendEnabled: wake.probe && wake.probe.sendEnabled,
      busyHint: wake.probe && wake.probe.busyHint,
      togglesClicked: wake.clicked,
      transcript: transcript.messages || [],
      rawTail: transcript.rawTail || '',
      ms: wake.ms,
      ...(wake.ok ? {} : { error: wake.error }),
    };
  }

  // Read-only: transcript + chatbox state, never clicks anything.
  async aiRead({ limit = 20 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const ed = await this._frame('editor');
    const probe = await this._aiProbe(ed);
    const transcript = await this._readAiTranscript(ed, limit);
    return {
      ok: true, ...probe,
      count: transcript.count != null ? transcript.count : (transcript.messages || []).length,
      messages: transcript.messages || [],
      rawTail: transcript.rawTail || '',
      transcriptError: transcript.error || undefined,
    };
  }

  // Full send-and-wait: wake -> fill #aiAgentInputEl -> click #aiAgentSendBtn ->
  // poll until the reply lands and the agent goes idle. Long AI edits can take
  // minutes; poll with perch_ai_read afterwards when it times out.
  async aiAsk({ text, timeout = PerchSession.AI_WAKE.askTimeoutMs, pollMs = PerchSession.AI_WAKE.pollMs, waitIdleMs = PerchSession.AI_WAKE.waitIdleMs, limit = 20 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    const W = PerchSession.AI_WAKE;
    if (!text || !String(text).trim()) return { ok: false, error: 'text is required (the message to send to the AI helper)' };
    if (String(text).length > W.maxChars) return { ok: false, error: 'text too long (' + String(text).length + ' chars, max ' + W.maxChars + ' per send — split it)' };
    this._touch();
    const t0 = Date.now();
    const ed = await this._frame('editor');
    const wake = await this._ensureAiPanel(ed, 15000);
    if (!wake.ok) return { ok: false, error: wake.error, stage: 'wake', probe: wake.probe, ms: Date.now() - t0 };
    // Baseline transcript so we can tell OUR reply apart from history.
    const before = await this._readAiTranscript(ed, 50);
    const beforeCount = before.count || 0;
    const beforeLast = (before.messages && before.messages.length)
      ? before.messages[before.messages.length - 1].text.slice(0, 120) : null;
    // If the agent is still busy from a previous task, wait for idle first.
    {
      const idleT0 = Date.now();
      while (Date.now() - idleT0 < Math.min(waitIdleMs || 0, 60000)) {
        const p = await this._aiProbe(ed);
        if (!p.busyHint && p.sendEnabled) break;
        await this.page.waitForTimeout(1000);
      }
    }
    // Fill the chatbox with a REAL user gesture (framework listeners need it).
    const msg = String(text);
    let filledVia = 'fill';
    try {
      const loc = ed.locator('#aiAgentInputEl').first();
      await loc.waitFor({ state: 'visible', timeout: 10000 });
      try { await loc.click({ timeout: 5000 }); } catch (e) {}
      try {
        await loc.fill(msg, { timeout: W.fillTimeoutMs });
      } catch (e) {
        // Fallback for rich/editors that reject fill: clear via eval, then type.
        filledVia = 'sequential';
        await evalMain(ed, () => {
          const el = document.querySelector('#aiAgentInputEl');
          if (el) {
            el.focus();
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }).catch(() => {});
        await loc.pressSequentially(msg.slice(0, W.maxChars), { delay: W.seqDelayMs, timeout: W.seqTimeoutMs });
      }
    } catch (e) {
      return { ok: false, error: 'could not fill #aiAgentInputEl: ' + String((e && e.message) || e).slice(0, 200), stage: 'fill', ms: Date.now() - t0 };
    }
    // Verify the text actually landed (fill can silently no-op on some builds:
    // bench T2d proves a stale .value leaves a controlled Send disabled).
    // Escalation: pressSequentially (if fill was used) -> native setter.
    let landed = await evalMain(ed, ({ msg }) => {
      const el = document.querySelector('#aiAgentInputEl');
      return el ? String(el.value || '') : null;
    }, { msg }).catch(() => null);
    if (typeof landed === 'string' && landed.trim().length < Math.min(msg.trim().length, 10)) {
      if (filledVia === 'fill') {
        filledVia = 'sequential';
        try {
          const loc2 = ed.locator('#aiAgentInputEl').first();
          await loc2.pressSequentially(msg.slice(0, W.maxChars), { delay: W.seqDelayMs, timeout: W.seqTimeoutMs });
        } catch (e) {}
        landed = await evalMain(ed, () => {
          const el = document.querySelector('#aiAgentInputEl');
          return el ? String(el.value || '') : null;
        }).catch(() => null);
      }
    }
    if (typeof landed === 'string' && landed.trim().length < Math.min(msg.trim().length, 10)) {
      // Last resort: native prototype setter + input/change events, so
      // framework-controlled composers accept the value (bench T2c).
      await evalMain(ed, ({ msg }) => {
        const el = document.querySelector('#aiAgentInputEl');
        if (!el) return;
        el.focus();
        try {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, msg); else el.value = msg;
        } catch (e) { el.value = msg; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, { msg }).catch(() => {});
    }
    // Settle (live-editor finding: Send enables on the input event — give the
    // framework a beat to flip `disabled` before the real click, instead of
    // racing it). Best-effort: a still-disabled button falls through to the
    // eval-click and Enter fallbacks below.
    try {
      await ed.waitForFunction(() => { const b = document.querySelector('#aiAgentSendBtn'); return !!(b && !b.disabled); }, null, { timeout: 3000 });
    } catch (e) {}
    // Click Send (real pointer click — synthetic el.click() can miss handlers).
    try {
      const btn = ed.locator('#aiAgentSendBtn').first();
      await btn.waitFor({ state: 'visible', timeout: 10000 });
      await btn.click({ timeout: 10000 });
    } catch (e) {
      const fb = await evalMain(ed, () => {
        const b = document.querySelector('#aiAgentSendBtn');
        if (!b) return { ok: false };
        b.click();
        return { ok: true };
      }).catch(() => ({ ok: false }));
      if (!fb || !fb.ok) {
        return { ok: false, error: 'could not click #aiAgentSendBtn: ' + String((e && e.message) || e).slice(0, 200), stage: 'send', ms: Date.now() - t0 };
      }
    }
    // Confirm the send registered: a REAL transition (observed text ->
    // cleared, or a new message), never an input that was already empty.
    // (Bench caught the phantom class: empty-on-arrival faking sent=true.)
    let sent = false, enterTried = false;
    const sawText = typeof landed === 'string' && landed.trim().length > 0;
    {
      const sT0 = Date.now();
      while (Date.now() - sT0 < W.sendConfirmMs) {
        const st = await evalMain(ed, () => {
          const el = document.querySelector('#aiAgentInputEl');
          const panel = document.querySelector('#aiAgentPanelEl');
          return { valueLen: el ? String(el.value || '').length : -1, textLen: panel ? String(panel.innerText || '').length : 0 };
        }).catch(() => null);
        if (sawText && st && st.valueLen === 0) { sent = true; break; }
        const tr = await this._readAiTranscript(ed, 50).catch(() => null);
        if (tr && (tr.count || 0) > beforeCount) { sent = true; break; }
        if (!enterTried && Date.now() - sT0 > W.enterFallbackAtMs) {
          enterTried = true;
          await evalMain(ed, () => {
            const el = document.querySelector('#aiAgentInputEl');
            if (!el) return;
            el.focus();
            for (const type of ['keydown', 'keypress', 'keyup']) {
              el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
            }
          }).catch(() => {});
        }
        await this.page.waitForTimeout(700);
      }
    }
    // Wait for the reply: new message(s) + agent back to idle.
    const deadline = Date.now() + Math.min(Math.max(timeout || 0, 5000), 600000);
    let lastCount = beforeCount, idleSince = null, lastStableText = null;
    let transcript = await this._readAiTranscript(ed, limit);
    while (Date.now() < deadline) {
      this._touch();
      const probe = await this._aiProbe(ed);
      transcript = await this._readAiTranscript(ed, limit);
      lastCount = transcript.count != null ? transcript.count : (transcript.messages || []).length;
      const grew = lastCount > beforeCount;
      const busy = !!(probe && probe.busyHint) || !!(probe && probe.sendDisabled);
      const curLast = (transcript.messages && transcript.messages.length)
        ? transcript.messages[transcript.messages.length - 1].text : '';
      if (curLast !== lastStableText) { lastStableText = curLast; idleSince = Date.now(); }
      if (grew && !busy && Date.now() - (idleSince || Date.now()) > W.stableMs) break; // settled
      if (grew && !busy) { await this.page.waitForTimeout(W.stableMs); continue; }
      await this.page.waitForTimeout(Math.min(Math.max(pollMs || 1000, 400), 5000));
    }
    const timedOut = Date.now() >= deadline;
    const msgs = transcript.messages || [];
    // Reply = everything appended since the baseline (usually [echo, answer]).
    let reply = null;
    if (msgs.length) {
      if (beforeLast != null && msgs.length && (before.count || 0) > 0) {
        // messages are capped to `limit`, so slice relative to the end.
        const fresh = msgs.filter((m) => m.text.slice(0, 120) !== beforeLast);
        reply = (fresh.length ? fresh : msgs).map((m) => '[' + m.role + '] ' + m.text).join('\n\n---\n\n') || null;
      } else {
        reply = msgs.map((m) => '[' + m.role + '] ' + m.text).join('\n\n---\n\n');
      }
    }
    return {
      ok: !timedOut, sent, timedOut,
      stage: timedOut ? 'wait-timeout' : 'done',
      reply, messages: msgs,
      countBefore: beforeCount, countAfter: lastCount,
      ms: Date.now() - t0,
      ...(timedOut
        ? { hint: 'the AI agent is still working (or its reply is long) — keep polling with perch_ai_read {limit} until busyHint is false, then read the tail' }
        : {}),
    };
  }

  // ---------------- liveness ----------------
  // Cheap pong for setup wizards (the bridge's mcp.ping equivalent): answers
  // with no browser, so Step 1 of any harness setup can prove the server is
  // alive before spending ~3s on a perch_start Cloudflare ladder.
  async ping() {
    this._touch();
    let ver = 'unknown';
    try { ver = require('./package.json').version; } catch (e) {}
    return { ok: true, pong: true, name: 'perch', version: ver, ts: Date.now(), running: !!this.page, generator: this.generator || null };
  }

  // Precise CDP-style composer probe (the bridge's chat.probe equivalent).
  // Returns the matched selector, tag/placeholder/aria, exact bounding rect +
  // center, viewport/DPR/scroll, visibility/enabled/zIndex, the send button's
  // rect, up to 8 candidate composers, message count, url + generatorName.
  // Read-only: never clicks, never types. Our exact #aiAgentInputEl /
  // #aiAgentSendBtn ids are tried first; generic heuristics follow in case an
  // editor build renames them (the lesson the bridge's CHAT_SELECTORS teach).
  async aiProbe({ scrollIntoView = false } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const ed = await this._frame('editor');
    const probe = await evalMain(ed, ({ scrollIntoView }) => {
      const COMPOSER_SELS = [
        '#aiAgentInputEl',
        'textarea[placeholder*="essage" i]',
        'textarea[placeholder*="ask" i]',
        'textarea[placeholder*="cribe" i]',
        'textarea[placeholder*="prompt" i]',
        '[contenteditable="true"]',
        'textarea',
      ];
      const SEND_SELS = [
        '#aiAgentSendBtn',
        'button[aria-label*="end" i]',
        'button[title*="end" i]',
        'button[type="submit"]',
        '[data-testid*="send" i]',
      ];
      const MSG_SELS = ['[class*="message"]', '[class*="chat"]', '[class*="reply"]', '[class*="assistant"]', '[class*="conversation"]', '[class*="thread"]'];
      const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, left: r.left, top: r.top, width: r.width, height: r.height, centerX: r.left + r.width / 2, centerY: r.top + r.height / 2 };
      };
      const cands = [];
      for (const s of COMPOSER_SELS) {
        let els = [];
        try { els = [...document.querySelectorAll(s)]; } catch (e) { continue; }
        for (const el of els) {
          const r = rectOf(el);
          cands.push({
            selector: s, tag: (el.tagName || '').toLowerCase(),
            placeholder: (el.getAttribute && el.getAttribute('placeholder')) || '',
            aria: (el.getAttribute && el.getAttribute('aria-label')) || '',
            rect: r, visible: r.width > 0 && r.height > 0,
          });
          if (cands.length >= 8) break;
        }
        if (cands.length >= 8) break;
      }
      const url = (() => { try { return location.href; } catch (e) { return ''; } })();
      const generatorName = (() => { try { return (location.pathname || '').split('/').filter(Boolean).pop() || ''; } catch (e) { return ''; } })();
      let composer = null, csel = '';
      for (const s of COMPOSER_SELS) {
        let el = null;
        try { el = document.querySelector(s); } catch (e) { el = null; }
        if (el) { composer = el; csel = s; break; }
      }
      if (!composer) return { ok: false, e: 'no composer found', candidates: cands, url, generatorName };
      if (scrollIntoView) { try { composer.scrollIntoView({ block: 'center' }); } catch (e) {} }
      const r = rectOf(composer);
      let cs = null;
      try { cs = getComputedStyle(composer); } catch (e) { cs = null; }
      let sendEl = null, sendSel = '';
      for (const s of SEND_SELS) {
        let el = null;
        try { el = document.querySelector(s); } catch (e) { el = null; }
        if (el) { sendEl = el; sendSel = s; break; }
      }
      let messageCount = 0;
      try {
        const all = [];
        for (const s of MSG_SELS) { try { for (const el of document.querySelectorAll(s)) all.push(el); } catch (e2) {} }
        messageCount = all.length;
      } catch (e) {}
      return {
        ok: true,
        composer: {
          selector: csel, tag: (composer.tagName || '').toLowerCase(),
          placeholder: (composer.getAttribute && composer.getAttribute('placeholder')) || '',
          aria: (composer.getAttribute && composer.getAttribute('aria-label')) || '',
          rect: r, visible: r.width > 0 && r.height > 0, enabled: !composer.disabled,
          inViewport: r.bottom > 0 && r.top < (window.innerHeight || 0) && r.right > 0 && r.left < (window.innerWidth || 0),
          display: cs ? cs.display : '', visibility: cs ? cs.visibility : '', opacity: cs ? cs.opacity : '', zIndex: cs ? cs.zIndex : '',
        },
        sendButton: sendEl ? { selector: sendSel, rect: rectOf(sendEl) } : null,
        candidates: cands.slice(0, 8), messageCount,
        viewport: { w: window.innerWidth, h: window.innerHeight }, devicePixelRatio: window.devicePixelRatio || 1,
        scroll: { x: window.scrollX, y: window.scrollY },
        url, generatorName,
      };
    }, { scrollIntoView: !!scrollIntoView }).catch((e) => ({ ok: false, e: String((e && e.message) || e) }));
    if (!probe || probe.ok !== true) {
      return { ok: false, via: 'playwright-eval', error: (probe && (probe.e || probe.error)) || 'probe failed', candidates: (probe && probe.candidates) || [], url: (probe && probe.url) || '', generatorName: (probe && probe.generatorName) || '' };
    }
    return { ok: true, via: 'playwright-eval', probe };
  }

  // Lightweight chat link state (the bridge's chat.status equivalent): one
  // eval, no transcript, never clicks. Poll this after a wake failure before
  // paying for the full perch_ai_probe rect walk or perch_ai_read transcript.
  async aiStatus() {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const ed = await this._frame('editor');
    const probe = await this._aiProbe(ed);
    if (probe.probeError) return { ok: false, error: probe.probeError };
    return {
      ok: true, via: 'playwright-eval',
      composer: !!probe.inputVisible,
      generatorFrame: true,
      panelVisible: !!probe.panelVisible,
      inputVisible: !!probe.inputVisible,
      inputEnabled: !!probe.inputEnabled,
      sendVisible: !!probe.sendVisible,
      sendEnabled: !!probe.sendEnabled,
      busyHint: !!probe.busyHint,
      messageCount: probe.messageCount != null ? probe.messageCount : null,
      url: probe.url || '', generatorName: probe.generatorName || '',
    };
  }

  // Connection doctor (the bridge's buildDoctor/statusJSON pattern): one JSON
  // plus one plain-language sentence naming the FIRST broken link and the one
  // call that fixes it. Works with no session. Check order is the pipeline
  // order: session -> cloudflare -> docs -> preview -> AI chat.
  async doctor() {
    const t0 = Date.now();
    if (!this.page) {
      return {
        ok: false, started: false, ms: Date.now() - t0,
        summary: 'No editor session — nothing is running yet.',
        nextAction: 'Call perch_start {name} (add collabKey when editing a shared room).',
        checks: {
          session: { started: false },
          docs: null, preview: null, cloudflare: null, aiChat: null,
          idle: { msSinceLastCall: Date.now() - this.last },
        },
      };
    }
    this._touch();
    const ed = await this._frame('editor');
    const st = await this.status().catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    const probe = await this._aiProbe(ed).catch((e) => ({ probeError: String((e && e.message) || e) }));
    let aiCount = null;
    try {
      const tr = await this._readAiTranscript(ed, 1);
      aiCount = tr.count != null ? tr.count : null;
    } catch (e) { aiCount = null; }
    const docsReady = !!(st && st.hasOutputView && st.hasModelView);
    const cfBlocked = !!(st && st.cfBlocked);
    const preview = (st && st.preview) || null;
    const previewHealthy = !!(preview && preview.healthy);
    const previewDead = !!(preview && preview.found && !preview.healthy);
    const aiReady = !!(probe && probe.inputVisible && probe.sendVisible && probe.sendEnabled);
    const aiBusy = !!(probe && probe.busyHint);
    const checks = {
      session: { started: true, generator: this.generator || null, engine: this.engine, effectiveEngine: this.effectiveEngine || this.engine, headed: this.headed },
      docs: { ready: docsReady, hasOutputView: !!(st && st.hasOutputView), hasModelView: !!(st && st.hasModelView), saveState: (st && st.saveState) || null, syntaxErrors: (st && st.syntaxErrors) || null, modelLines: (st && st.modelLines) || null, outputLines: (st && st.outputLines) || null },
      preview: preview ? { healthy: previewHealthy, booted: !!preview.booted, loaderError: !!preview.loaderError, text: (preview.text || '').slice(0, 120) } : { healthy: null, note: 'no preview frame yet' },
      cloudflare: { blocked: cfBlocked },
      aiChat: { ready: aiReady, busy: aiBusy, inputVisible: !!(probe && probe.inputVisible), sendEnabled: !!(probe && probe.sendEnabled), messageCount: aiCount, url: (probe && probe.url) || '' },
      idle: { msSinceLastCall: Date.now() - this.last, autoCloseMs: IDLE_MS },
    };
    let summary, nextAction, ok;
    if (cfBlocked) {
      ok = false;
      summary = 'Cloudflare challenge is blocking the editor page.';
      nextAction = 'Call perch_start again (it auto-escalates: fresh context → relaunch → headed → next engine).';
    } else if (!docsReady) {
      ok = false;
      summary = 'Editor docs are not ready (views or content missing).';
      nextAction = 'Call perch_start again (add force:true to reload); if the page looks blank, wait ~40s and re-check perch_status.';
    } else if (previewDead) {
      ok = false;
      summary = 'Editor is fine but the generator preview never booted' + (preview && preview.loaderError ? ' (its file loader did not become available).' : '.');
      nextAction = 'Call perch_start {force:true} once; if it persists, retry with engineChain starting at another engine (firefox → chrome → chromium).';
    } else if (!aiReady) {
      ok = false;
      summary = 'Editor + preview are healthy, but the built-in AI chatbox is not visible (the shared panel is probably on the files view).';
      nextAction = 'Call perch_ai_wake {} (re-opens the AI tab), then perch_ai_probe {} if it still fails.';
    } else if (aiBusy) {
      ok = true;
      summary = 'All green, and the AI helper is currently working — do not send yet.';
      nextAction = 'Poll perch_ai_read {limit} until busyHint is false, then read the tail (or send with perch_ai_ask, which waits for idle first).';
    } else {
      ok = true;
      summary = 'All green — session, docs, preview and AI chat are ready.';
      nextAction = 'None needed. Send work with perch_ai_ask, or edit directly with perch_patch and verify with perch_errors.';
    }
    return { ok, summary, nextAction, checks, ms: Date.now() - t0 };
  }

  // Zip backup (the bridge's DownloadsPlugin / Kilo-export pattern): a
  // byte-exact snapshot of main.pjs + index.html + every src/* file the
  // public manifest lists, as one STORE zip (no compression, no new deps).
  // Browser-free and collab-safe: it reads the last OWNER save via the public
  // API, never the live room. Take one before any risky whole-pane rewrite.
  async exportZip({ name = null, dir = null, outPath = null } = {}) {
    const t0 = Date.now();
    const gen = name || this.generator;
    if (!gen) throw new Error('no generator — pass name or call perch_start first');
    this._touch();
    const g = this.apiData({ name: gen });
    const model = g.modelText || '';
    const html = g.outputTemplate || '';
    if (!model && !html) return { ok: false, error: 'public API returned no source for "' + gen + '"' };
    const manifest = (g.srcManifest && typeof g.srcManifest === 'object') ? g.srcManifest : {};
    const files = [
      { name: 'main.pjs', data: Buffer.from(model, 'utf8') },
      { name: 'index.html', data: Buffer.from(html, 'utf8') },
    ];
    const srcErrors = [];
    const keys = Object.keys(manifest).slice(0, 1000);
    for (const p of keys) {
      const key = manifest[p] && manifest[p].key;
      if (!key) { srcErrors.push(p + ': no CDN key'); continue; }
      try {
        const buf = this._curlBuffer('https://user.uploads.dev/file/' + key);
        if (!buf || !buf.length) { srcErrors.push(p + ': empty body'); continue; }
        if (buf.length > 25 * 1024 * 1024) { srcErrors.push(p + ': over 25 MB, skipped'); continue; }
        files.push({ name: 'src/' + p, data: buf });
      } catch (e) { srcErrors.push(p + ': ' + String((e && e.message) || e).slice(0, 120)); }
    }
    const totalBytes = files.reduce((a, f) => a + f.data.length, 0);
    if (totalBytes > 100 * 1024 * 1024) return { ok: false, error: 'workspace too large for a zip export (' + totalBytes + ' bytes > 100 MB)' };
    const zip = _buildStoreZip(files);
    const out = outPath || path.join(dir || path.join(MIRROR_ROOT, gen), gen + '.zip');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zip);
    return {
      ok: true, generator: gen, path: out, bytes: zip.length, ms: Date.now() - t0,
      entries: files.map((f) => ({ name: f.name, size: f.data.length })),
      srcFiles: files.length - 2, srcErrors: srcErrors.slice(0, 20),
      hint: 'Byte-exact snapshot (STORE zip, no compression). Re-import with perch_write_file per pane + perch_upload_src per src file.',
    };
  }

  // ---------------- offline agent shelf (browser-free continuity) ----------------
  // Ports of the bridge generator's src/shelf.js impls, file-backed under
  // .perch-shelf/shelf.json so think/memory/todo state survives the ~20 min
  // browser idle-close, compaction, and sessions that never call perch_start.
  async think({ thought, next = null } = {}) {
    if (!thought || !String(thought).trim()) return { ok: false, error: 'thought is required' };
    this._touch();
    const s = _shelfLoad();
    s.thoughts.push(String(thought).slice(0, 800));
    const total = s.thoughts.length;
    _shelfSave({ mem: s.mem, thoughts: s.thoughts.slice(-50), todos: s.todos });
    return { ok: true, step: total, total, ...(next ? { next: String(next).slice(0, 200) } : {}) };
  }

  async memory({ action, entity = null, observation = null, query = null } = {}) {
    const a = String(action || '').toLowerCase();
    if (!['remember', 'recall', 'forget'].includes(a)) return { ok: false, error: 'action must be remember|recall|forget' };
    this._touch();
    const s = _shelfLoad();
    if (a === 'remember') {
      if (!entity || !observation) return { ok: false, error: 'remember needs {entity, observation}' };
      const k = String(entity).slice(0, 80);
      (s.mem[k] = s.mem[k] || []).push(String(observation).slice(0, 500));
      _shelfSave(s);
      return { ok: true, action: a, entity: k, facts: s.mem[k].length };
    }
    if (a === 'recall') {
      const q = String(query || '').toLowerCase();
      const out = [];
      for (const k of Object.keys(s.mem)) {
        const hits = s.mem[k].filter((o) => !q || o.toLowerCase().includes(q) || k.toLowerCase().includes(q));
        if (hits.length) out.push({ entity: k, facts: hits });
      }
      return { ok: true, action: a, query: query || null, entities: out.length, results: out.slice(0, 50) };
    }
    if (!entity) {
      const n = Object.keys(s.mem).length;
      s.mem = {};
      _shelfSave(s);
      return { ok: true, action: a, erasedEntities: n };
    }
    delete s.mem[String(entity)];
    _shelfSave(s);
    return { ok: true, action: a, entity: String(entity) };
  }

  async todo({ action, text = null, id = null } = {}) {
    const a = String(action || '').toLowerCase();
    if (!['add', 'list', 'done', 'clear'].includes(a)) return { ok: false, error: 'action must be add|list|done|clear' };
    this._touch();
    const s = _shelfLoad();
    if (a === 'add') {
      if (!text || !String(text).trim()) return { ok: false, error: 'add needs {text}' };
      const item = { id: 't' + Date.now().toString(36), text: String(text).slice(0, 300), done: false };
      s.todos.push(item);
      _shelfSave(s);
      return { ok: true, action: a, item, total: s.todos.length };
    }
    if (a === 'list') {
      return { ok: true, action: a, total: s.todos.length, open: s.todos.filter((t) => !t.done).length, items: s.todos.slice(-100) };
    }
    if (a === 'done') {
      if (!id) return { ok: false, error: 'done needs {id}' };
      const t = s.todos.find((x) => x.id === id || (id && x.id.endsWith(id)));
      if (!t) return { ok: false, error: 'todo not found: ' + id, total: s.todos.length };
      t.done = true;
      _shelfSave(s);
      return { ok: true, action: a, item: t };
    }
    const n = s.todos.length;
    s.todos = [];
    _shelfSave(s);
    return { ok: true, action: a, cleared: n };
  }

  async clock({ timezone = 'UTC' } = {}) {
    const tz = String(timezone || 'UTC');
    try {
      const now = new Date();
      const display = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(now);
      return { ok: true, timezone: tz, iso: now.toISOString(), display: now.toString() + ' | ' + tz + ': ' + display };
    } catch (e) {
      return { ok: false, error: 'bad timezone "' + tz + '" — use an IANA zone like UTC or America/New_York', iso: new Date().toISOString() };
    }
  }

  async calc({ expr } = {}) {
    if (expr == null || !String(expr).trim()) return { ok: false, error: 'expr is required' };
    const r = _calcSafe(expr);
    if (r.error) return { ok: false, error: r.error, expr: String(expr).slice(0, 200) };
    return { ok: true, expr: String(expr).slice(0, 200), result: r.value };
  }

  // Worker-style JS without a browser: runs inside Node's vm sandbox with a
  // wall-clock timeout. User-code throws and timeouts come back as ok:true
  // tool output (like the bridge shelf) so the agent sees them as results;
  // only tool misuse (no code, too long) is ok:false.
  async runJs({ code, timeoutMs = 5000 } = {}) {
    const src = String(code == null ? '' : code);
    if (!src.trim()) return { ok: false, error: 'code is required' };
    if (src.length > 4000) return { ok: false, error: 'code too long (' + src.length + ' chars, max 4000)' };
    const t = Math.min(Math.max(+timeoutMs || 5000, 100), 10000);
    this._touch();
    try {
      const vm = require('vm');
      const out = vm.runInNewContext('"use strict";' + src, {}, { timeout: t });
      const text = out === undefined ? '(undefined)' : String(out);
      return { ok: true, result: text.slice(0, 4000) };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/timed out/i.test(msg)) return { ok: true, result: 'timeout after ' + t + 'ms', timedOut: true };
      return { ok: true, result: 'error: ' + msg.slice(0, 500) };
    }
  }

  async webFetch({ url, maxChars = 8000 } = {}) {
    if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, error: 'url must be a full https:// URL' };
    const max = Math.min(Math.max(+maxChars || 8000, 500), 20000);
    this._touch();
    try {
      const stripped = _stripHtml(this._curlText(String(url)));
      return { ok: true, url: String(url), chars: Math.min(stripped.length, max), truncated: stripped.length > max, text: stripped.slice(0, max) || '(empty page)' };
    } catch (e) {
      return { ok: false, error: 'fetch failed: ' + String((e && e.message) || e).slice(0, 200), url: String(url) };
    }
  }

  async webSearch({ query, n = 5 } = {}) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'query is required' };
    const count = Math.min(Math.max(+n || 5, 1), 10);
    this._touch();
    const results = [];
    try {
      const raw = this._curlText('https://api.duckduckgo.com/?q=' + encodeURIComponent(q) + '&format=json&no_html=1&skip_disambig=1');
      const j = JSON.parse(raw);
      if (j.Abstract) results.push({ source: 'ddg', text: String(j.Abstract).slice(0, 600), url: j.AbstractURL || null });
      for (const t of (j.RelatedTopics || []).slice(0, count)) {
        const u = t.FirstURL || (t.Topics && t.Topics[0] && t.Topics[0].FirstURL) || null;
        if (t.Text) results.push({ source: 'ddg', text: String(t.Text).slice(0, 220), url: u });
        if (results.length >= count + 1) break;
      }
    } catch (e) {}
    try {
      const raw2 = this._curlText('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(q) + '&format=json&origin=*&srlimit=' + count);
      const j2 = JSON.parse(raw2);
      for (const s of ((j2.query && j2.query.search) || [])) {
        results.push({ source: 'wiki', text: s.title, url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(s.title).replace(/ /g, '_')) });
      }
    } catch (e) {}
    const text = results.map((r) => '- ' + r.text + (r.url ? ' ' + r.url : '')).join('\n').slice(0, 4000);
    return { ok: true, query: q, count: results.length, results: results.slice(0, 20), text: text || '(no results)' };
  }

  // Static skill catalog (the bridge's skill.list equivalent): the 13 agent
  // skill ids with titles and one-line descriptions. Browser-free. To load
  // one into the AI helper: perch_ai_ask {text: "load the skill <id> and
  // follow it for this task"}.
  async skills() {
    return { ok: true, count: SKILLS.length, skills: SKILLS.map((s) => ({ id: s.id, title: s.title, description: s.description, prompt: 'skills.' + s.id })) };
  }

  async stop() {
    if (this._idle) { clearInterval(this._idle); this._idle = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
    if (this.browser) { try { await this.browser.close(); } catch {} this.browser = null; }
    this.page = null;
    this.ready = false;
    this.generator = null;
    this.collabKey = null;
    this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    return { ok: true, stopped: true };
  }
}

module.exports = { PerchSession, buildEditorUrl, isCfBlocked, MIRROR_ROOT };
