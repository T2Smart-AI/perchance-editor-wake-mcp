// perch-tools.mjs — shared tool schemas + dispatch table for the perch MCP
// server entries. perch-mcp.mjs (modern 2026-07-28 discover flow) and
// perch-mcp-legacy.mjs (legacy initialize/tools-list/tools-call handshake)
// both serve this exact set, so the two entries can never drift.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PerchSession } = require("./perch-core.js");

export const session = new PerchSession();

const PANE = { type: "string", enum: ["model", "output"] };
const FRAME = { type: "string", enum: ["preview", "editor"] };

// ----------------------------- tool schemas -----------------------------
export const TOOLS = [
  {
    name: "perch_start",
    description:
      "Start the Perchance editor session: launch the browser and load the given generator with its collab key, ready to edit — one call. Handles Cloudflare automatically (steps inside an engine, then the next engine in engineChain). Re-calling with the same generator/collabKey is a fast no-op. Omit collabKey for a non-collab edit (must own the generator). Reports the PREVIEW's health too: the editor page can be fine while the generator frame never boots ('This generator could not start because its file loader did not become available') — in that case the ladder has already tried the other engines, and the result says previewDegraded.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Generator name, e.g. 'minimal'" },
        collabKey: { type: "string", description: "Collab key from the editor URL hash (#edit:collab=KEY)" },
        headed: { type: "boolean", description: "Show a visible browser window. Default false. Chromium-family engines cannot clear Cloudflare headless, so they only work with headed:true" },
        engine: { type: "string", enum: ["firefox", "chrome", "chromium", "patchright"], description: "Browser engine to start with. 'firefox' (DEFAULT) = plain playwright firefox: the only engine that clears Cloudflare on perchance.org subdomains AND the only one that can use Perchance's server-side generation plugins (ai-text replies, src uploads). 'chrome' = plain playwright chromium (no stealth): drives the editor and the preview when headed:true, but cannot reach the ai-text/upload embeds. 'chromium' = the same plus the legacy stealth args. 'patchright' = patched-playwright chromium: clears Cloudflare headed, but the platform's editor globals (window.outputTemplateEditor / window.modelTextEditor) never publish, so docs cannot be read or written." },
        engineChain: { type: "array", items: { type: "string", enum: ["firefox", "chrome", "chromium", "patchright"] }, description: "Engines to try IN ORDER when one cannot load the editor or its preview. Default: the recommended chain starting at `engine` (firefox -> chrome -> chromium -> patchright). Pass [\"firefox\"] (or false) to pin one engine and never switch." },
        width: { type: "integer", description: "Viewport width. Default 1500" },
        height: { type: "integer", description: "Viewport height. Default 950" },
        force: { type: "boolean", description: "Reload even if already on this generator" },
        persistProfile: { type: "boolean", description: "Keep ONE browser profile dir across starts (launchPersistentContext) so the editor's localStorage client id and AI chat history survive restarts. Default false (fresh profile each start). First use creates .perch-profile under the server's working directory" },
        profileDir: { type: "string", description: "Profile dir for persistProfile (or PERCH_PROFILE_DIR env). Default .perch-profile" },
      },
      required: ["name"],
    },
  },
  {
    name: "perch_status",
    description: "Report live editor state: save state, syntax errors, collab sync, line counts, engine, CF status, buffered console/error counts, and the preview's health (preview.booted / preview.loaderError). preview.loaderError true means the generator frame reported 'its file loader did not become available' - the app never booted there, so every perch_eval/perch_click against the preview will hang. Fix: perch_start again (fresh context), then a different engine via engineChain.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_pull",
    description:
      "BROWSER-FREE code access. Fetch the authoritative modelText (main.pjs) and outputTemplate (index.html) from Perchance's public API in ~1.2s — no browser, no Cloudflare, no collab key needed — and write them to local files. Grep/read those files directly for full-speed, full-text search of a 40k-line generator. Works without perch_start.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Generator name. Defaults to the current session generator" },
        dir: { type: "string", description: "Output directory. Default <perch dir>/.perch-mirror/<name>" },
      },
      required: [],
    },
  },
  {
    name: "perch_read",
    description: "Read a pane (model=main.pjs, output=index.html) from the LIVE editor as 1-indexed numbered lines.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        offset: { type: "integer", description: "First line (1-indexed). Default 1" },
        limit: { type: "integer", description: "Max lines. Default 2000" },
      },
      required: [],
    },
  },
  {
    name: "perch_grep",
    description: "Regex search across one pane (or both if pane omitted). Returns matching lines with optional context.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JS regex pattern" },
        pane: { ...PANE, description: "Omit to search both" },
        contextLines: { type: "integer", description: "Lines of context around each hit. Default 0" },
        limit: { type: "integer", description: "Max matches returned. Default 200" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "perch_edit",
    description: "Surgical find/replace in a pane. Yjs settle runs by default so the edit survives a reload.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        oldString: { type: "string", description: "Exact text to find" },
        newString: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "Replace all occurrences. Default false" },
        nth: { type: "integer", description: "Replace only the Nth occurrence (1-indexed)" },
        settle: { type: "boolean", description: "Settle Yjs sync after edit. Default true" },
      },
      required: ["oldString", "newString"],
    },
  },
  {
    name: "perch_patch",
    description: "Apply multiple surgical changes in one call. Each change: {pane, oldString, newString, replaceAll?, nth?}.",
    inputSchema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pane: PANE,
              oldString: { type: "string" },
              newString: { type: "string" },
              replaceAll: { type: "boolean" },
              nth: { type: "integer" },
            },
            required: ["oldString", "newString"],
          },
        },
        settle: { type: "boolean", description: "Settle Yjs sync after all changes. Default true" },
      },
      required: ["changes"],
    },
  },
  {
    name: "perch_write",
    description: "Replace an entire pane's document with new content.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        content: { type: "string", description: "Full new document text" },
        settle: { type: "boolean", description: "Settle Yjs sync after write. Default true" },
      },
      required: ["content"],
    },
  },
  {
    name: "perch_write_file",
    description:
      "Replace an entire pane's document with a LOCAL file's contents, read server-side (byte-exact). " +
      "The large-document path: perch_write cannot carry a 2.6 MB outputTemplate through one MCP call, " +
      "and the editor page's CSP blocks fetching it from localhost. Same dispatch as perch_write.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        filePath: { type: "string", description: "Absolute local path to the file to load" },
        settle: { type: "boolean", description: "Settle Yjs sync after write. Default true" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "perch_outline",
    description: "Line map of function/class/const declarations — orient in a 40k-line file without reading it all.",
    inputSchema: {
      type: "object",
      properties: {
        pane: { ...PANE, description: "Default output" },
        limit: { type: "integer", description: "Max entries. Default 400" },
      },
      required: [],
    },
  },
  {
    name: "perch_copy_lines",
    description: "Byte-exact copy of source lines into a destination pane (after a target line, or append).",
    inputSchema: {
      type: "object",
      properties: {
        fromPane: PANE,
        startLine: { type: "integer", description: "First line to copy (1-indexed)" },
        endLine: { type: "integer", description: "Last line to copy (inclusive). Default startLine" },
        toPane: { ...PANE, description: "Default fromPane" },
        afterLine: { type: "integer", description: "Insert after this line. Omit to append" },
      },
      required: ["startLine"],
    },
  },
  {
    name: "perch_refresh",
    description: "Hard-reload the live preview and report syntax errors, runtime errors and new console lines.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_console",
    description: "Read the console: Perchance's #console-output panel plus the buffered console + runtime errors captured from every frame.",
    inputSchema: {
      type: "object",
      properties: { clear: { type: "boolean", description: "Clear the buffers after reading. Default false" } },
      required: [],
    },
  },
  {
    name: "perch_errors",
    description: "Error triage in one call: editor syntax errors (window.getEditorSyntaxErrors) + buffered runtime/page errors + console tail. Use clear:true to reset buffers after a fix.",
    inputSchema: {
      type: "object",
      properties: { clear: { type: "boolean", description: "Clear buffers after reading. Default false" } },
      required: [],
    },
  },
  {
    name: "perch_eval",
    description: "Run a JS expression and return its value. Default frame is the running generator ('preview'); use frame:'editor' for the editor page.",
    inputSchema: {
      type: "object",
      properties: {
        js: { type: "string", description: "JS expression to evaluate" },
        frame: { ...FRAME, description: "Default preview" },
      },
      required: ["js"],
    },
  },
  {
    name: "perch_snapshot",
    description: "Text-first UI testing: list the visible interactive elements (buttons/inputs/links) in the live preview with a ready-to-use CSS selector each. Use this instead of screenshots to find what to click.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { ...FRAME, description: "Default preview" },
        filter: { type: "string", description: "Only elements whose label/tag contains this text" },
        limit: { type: "integer", description: "Max elements. Default 250" },
      },
      required: [],
    },
  },
  {
    name: "perch_wait",
    description: "Wait for a selector or visible text to appear (or vanish with gone:true) in the preview. Use after a click/edit before asserting.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector or 'text=Visible Text'" },
        text: { type: "string", description: "Visible text to wait for" },
        gone: { type: "boolean", description: "Wait for it to DISAPPEAR instead. Default false" },
        frame: { ...FRAME, description: "Default preview" },
        timeout: { type: "integer", description: "ms. Default 15000" },
      },
      required: [],
    },
  },
  {
    name: "perch_click",
    description: "Click an element in the live preview (or editor chrome). selector: CSS selector or 'text=Visible Text'.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector or 'text=...'" },
        frame: { ...FRAME, description: "Default preview" },
        nth: { type: "integer", description: "Click the Nth match instead of the first" },
        timeout: { type: "integer", description: "ms. Default 10000" },
      },
      required: ["selector"],
    },
  },
  {
    name: "perch_hover",
    description: "Move the real mouse over an element so CSS :hover applies (hover-revealed controls, tooltips). JS clicks and evals cannot do this. Pair with perch_eval + getComputedStyle to assert hover styles.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector or 'text=...'" },
        frame: { ...FRAME, description: "Default preview" },
        nth: { type: "integer", description: "Hover the Nth match instead of the first" },
        timeout: { type: "integer", description: "ms. Default 10000" },
      },
      required: ["selector"],
    },
  },
  {
    name: "perch_type",
    description: "Type text into an element in the live preview (or editor chrome).",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector or 'text=...'" },
        text: { type: "string", description: "Text to type" },
        frame: { ...FRAME, description: "Default preview" },
        submit: { type: "boolean", description: "Press Enter after typing. Default false" },
        timeout: { type: "integer", description: "ms. Default 10000" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "perch_press",
    description: "Press a key (Enter, Tab, Escape, ...) on the focused element.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name, e.g. 'Enter'" },
        frame: { ...FRAME, description: "Default editor" },
      },
      required: ["key"],
    },
  },
  {
    name: "perch_shot",
    description: "Screenshot. what: 'editor' (default) = whole editor page; 'preview' = the running generator iframe.",
    inputSchema: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["editor", "preview"], description: "Default editor" },
        path: { type: "string", description: "Output file path" },
      },
      required: [],
    },
  },
  {
    name: "perch_src",
    description: "Read a src/ file (from the generator's srcManifest) via the CDN.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "src path, e.g. AGENTS.md" } },
      required: ["path"],
    },
  },
  {
    name: "perch_list_src",
    description: "List all src/ files in the generator's srcManifest with sizes.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_set_viewport",
    description: "Resize the live preview and report the iframe rect.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "integer", description: "Default 1500" },
        height: { type: "integer", description: "Default 950" },
      },
      required: [],
    },
  },
  {
    name: "perch_fetch_generator",
    description: "Fetch a public generator's source (modelText + outputTemplate) to local files. Alias of perch_pull.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Generator name" },
        path: { type: "string", description: "Output directory hint" },
      },
      required: ["name"],
    },
  },
  {
    name: "perch_stop",
    description: "Close the browser session. Call perch_start again to resume.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_navigate",
    description: "Navigate the whole editor PAGE to any https:// URL (top-level). Recovery tool: a Cloudflare interstitial can never render inside iframes, so when an embed/subframe (e.g. text-generation.perchance.org under the ai-text-plugin) is CF-blocked, visit that URL top-level once, let the challenge clear, then perch_start with force:true to reload the editor. Also loads arbitrary pages for inspection. Waits for a CF challenge to clear.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https:// URL to open top-level" },
        timeout: { type: "integer", description: "ms to wait for a CF challenge to clear. Default 30000" },
      },
      required: ["url"],
    },
  },
  {
    name: "perch_upload_src",
    description: "Upload a file into the generator's src/ via the editor's file panel. Source the bytes WITHOUT passing them through the conversation: prefer filePath (absolute local path, read server-side, byte-exact) or url (https, fetched server-side); inline content still works for small text. name may carry a virtual folder path (emoji/icon.svg) — the src store is flat string keys and the tree groups '/' keys into folders. overwrite:true deletes an existing file at that path first (the editor otherwise renames colliding uploads to name-2.ext instead of replacing). Lands in the editor src store ('saved'); goes public when the generator's owner saves.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name or path, e.g. README.md or emoji/icon.svg (folders are virtual)" },
        content: { type: "string", description: "Inline file content — small text only; it transits the model's context (transcription risk on big/dense files). Prefer filePath or url." },
        filePath: { type: "string", description: "ABSOLUTE local path read server-side, e.g. C:/Users/you/Workspace/app/src/emoji/x.svg — byte-exact, nothing transits the conversation" },
        url: { type: "string", description: "https URL fetched server-side (e.g. a raw.githubusercontent.com file) — nothing transits the conversation" },
        binary: { type: "boolean", description: "Force binary (base64 → real bytes page-side) or text handling. Default: inferred from the CONTENT (NUL-byte + strict-UTF-8 sniff), so unknown extensions like .onnx upload byte-exact" },
        timeout: { type: "integer", description: "ms to wait for the panel's 'saved' marker. Default 25000" },
        overwrite: { type: "boolean", description: "Delete an existing file at this path first, so the upload replaces it instead of being renamed. Default false" },
      },
      required: ["name"],
    },
  },
  {
    name: "perch_delete_src",
    description: "Delete a file from the generator's src/ via the editor's file tree (⋯ → 🗑️ delete → confirm). Staged in the editor store; the deletion goes public when the generator's owner saves. Pass the path the file lives under, e.g. AGENTS.md or emoji/old.svg.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "src path, e.g. AGENTS.md or emoji/old.svg" },
        timeout: { type: "integer", description: "ms to wait for the row to disappear. Default 20000" },
      },
      required: ["path"],
    },
  },
  {
    name: "perch_ai_wake",
    description: "WAKE the editor's built-in AI coding agent: ensure its shared side panel (#aiAgentPanelEl) is back on the chat view and its only inputs — <textarea id=\"aiAgentInputEl\"> + <button id=\"aiAgentSendBtn\"> — are visible and enabled. Call this before perch_ai_ask, and after perch_upload_src/perch_delete_src (those leave the panel on the files view). Returns readiness flags plus the recent transcript tail.",
    inputSchema: {
      type: "object",
      properties: {
        timeout: { type: "integer", description: "ms to keep hunting for the AI tab. Default 15000" },
        limit: { type: "integer", description: "Transcript messages to return. Default 10" },
      },
      required: [],
    },
  },
  {
    name: "perch_ai_ask",
    description: "Talk to the editor's built-in AI coding agent through its ONLY access — fill #aiAgentInputEl and click #aiAgentSendBtn — then wait for the reply and return it. Auto-wakes the panel first (same as perch_ai_wake). Long edits can take minutes: on a wait-timeout (ok:false, timedOut:true) keep polling with perch_ai_read until busyHint is false. This is how an outside coding agent delegates to the Perchance AI helper.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message to send to the AI helper, e.g. 'add a score counter to the game'" },
        timeout: { type: "integer", description: "ms to wait for the reply. Default 180000, max 600000" },
        pollMs: { type: "integer", description: "Poll interval while waiting. Default 1000" },
        waitIdleMs: { type: "integer", description: "ms to wait for a previous AI task to finish before sending. Default 30000" },
        limit: { type: "integer", description: "Transcript messages to return. Default 20" },
      },
      required: ["text"],
    },
  },
  {
    name: "perch_ai_read",
    description: "Read-only transcript of the built-in AI helper: chatbox state (#aiAgentInputEl/#aiAgentSendBtn visible+enabled, busyHint) plus the last messages. Never clicks anything — safe to poll after a perch_ai_ask timeout while the agent is still working.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max messages. Default 20" },
      },
      required: [],
    },
  },
  {
    name: "perch_ping",
    description: "Cheap liveness pong — answers with no browser and no session (setup Step 1). Proves the server is alive before spending ~3s on a perch_start Cloudflare ladder.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_ai_probe",
    description: "Precise CDP-style probe of the editor AI chat composer: matched selector, tag/placeholder/aria, exact bounding rect + center, viewport/DPR/scroll, visibility/enabled/zIndex, send-button rect, up to 8 candidate composers, message count, url + generatorName. Read-only — never clicks or types. Run this when perch_ai_wake fails (an editor rebuild may have moved the chatbox).",
    inputSchema: {
      type: "object",
      properties: {
        scrollIntoView: { type: "boolean", description: "Scroll the composer into view before measuring. Default false" },
      },
      required: [],
    },
  },
  {
    name: "perch_ai_status",
    description: "Lightweight chat link state: composer found, panel/input/send visible+enabled, busyHint, message count, url. One eval, no transcript, never clicks — cheaper than perch_ai_read for polling whether a send is possible.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_doctor",
    description: "Connection doctor: one JSON plus one plain-language sentence naming the FIRST broken link (session → Cloudflare → docs → preview → AI chat) and the one call that fixes it. Works with no session. Call this when anything looks wrong instead of guessing.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_export",
    description: "Zip backup: byte-exact snapshot of main.pjs + index.html + every src/* file the public manifest lists, as one STORE zip (no compression, no new deps). Browser-free and collab-safe — reads the last OWNER save via the public API, never the live room. Take one before any risky whole-pane rewrite.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Generator name. Defaults to the current session generator" },
        dir: { type: "string", description: "Output directory. Default <perch dir>/.perch-mirror/<name>" },
        outPath: { type: "string", description: "Exact output .zip path. Default <dir>/<name>.zip" },
      },
      required: [],
    },
  },
  {
    name: "perch_think",
    description: "Structured reasoning scratchpad (offline, browser-free). Logs a thought to the file-backed shelf (.perch-shelf/shelf.json — survives the ~20 min browser idle-close); returns the step count.",
    inputSchema: {
      type: "object",
      properties: {
        thought: { type: "string", description: "Reasoning step" },
        next: { type: "string", description: "What to do next (optional)" },
      },
      required: ["thought"],
    },
  },
  {
    name: "perch_memory",
    description: "Durable memory (offline, browser-free, file-backed). remember needs {entity, observation}; recall takes an optional {query} (empty = all); forget with an {entity} erases it, without erases all.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["remember", "recall", "forget"] },
        entity: { type: "string", description: "Who/what this is about" },
        observation: { type: "string", description: "Fact to store (remember only)" },
        query: { type: "string", description: "Search words (recall only, empty = all)" },
      },
      required: ["action"],
    },
  },
  {
    name: "perch_todo",
    description: "Task board (offline, browser-free, file-backed). add needs {text}; list shows all; done needs {id} (suffix match ok); clear empties the board.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "done", "clear"] },
        text: { type: "string", description: "Task text (add only)" },
        id: { type: "string", description: "Task id (done only)" },
      },
      required: ["action"],
    },
  },
  {
    name: "perch_clock",
    description: "Current date/time with timezone support (offline, browser-free).",
    inputSchema: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA zone, e.g. UTC or America/New_York. Default UTC" },
      },
      required: [],
    },
  },
  {
    name: "perch_calc",
    description: "Safe calculator (offline, browser-free). Numbers, +-*/().,%,^ and Math names only (sqrt/sin/cos/log aliases) — no variables, no function definitions.",
    inputSchema: {
      type: "object",
      properties: {
        expr: { type: "string", description: "e.g. (12*7+3)/4 or sqrt(2)^2" },
      },
      required: ["expr"],
    },
  },
  {
    name: "perch_run_js",
    description: "Run a short sync JS snippet in a Node vm sandbox with a wall-clock timeout (offline, browser-free). User-code throws and timeouts come back as ok:true tool output so the agent sees them as results.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Sync JS; `return` supported. Max 4000 chars" },
        timeoutMs: { type: "integer", description: "Wall-clock cap ms (100–10000). Default 5000" },
      },
      required: ["code"],
    },
  },
  {
    name: "perch_web_fetch",
    description: "Fetch a page (browser-free, via curl) as readable text: scripts/styles stripped, HTML entities decoded, capped at maxChars.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full https:// URL" },
        maxChars: { type: "integer", description: "Max chars (500–20000). Default 8000" },
      },
      required: ["url"],
    },
  },
  {
    name: "perch_web_search",
    description: "Keyless search (browser-free): DuckDuckGo instant + Wikipedia, merged and capped.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        n: { type: "integer", description: "Max per-source results (1–10). Default 5" },
      },
      required: ["query"],
    },
  },
  {
    name: "perch_skills",
    description: "List the 13 agent skill ids (ai-text-plugin, server-plugin, …) with one-line descriptions. Browser-free. To load one into the AI helper: perch_ai_ask {text: 'load the skill <id> and follow it for this task'}.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ----------------------------- dispatch -----------------------------
export const DISPATCH = {
  perch_start: (a) => session.start(a),
  perch_status: () => session.status(),
  perch_pull: (a) => session.pull(a),
  perch_read: (a) => session.read(a),
  perch_grep: (a) => session.grep(a),
  perch_edit: (a) => session.edit(a),
  perch_patch: (a) => session.patch(a),
  perch_write: (a) => session.write(a),
  perch_write_file: (a) => session.writeFile(a),
  perch_outline: (a) => session.outline(a),
  perch_copy_lines: (a) => session.copyLines(a),
  perch_refresh: () => session.refresh(),
  perch_console: (a) => session.console(a),
  perch_errors: (a) => session.errors(a),
  perch_eval: (a) => session.eval(a),
  perch_snapshot: (a) => session.snapshot(a),
  perch_wait: (a) => session.wait(a),
  perch_click: (a) => session.click(a),
  perch_hover: (a) => session.hover(a),
  perch_type: (a) => session.type(a),
  perch_press: (a) => session.press(a),
  perch_shot: (a) => session.shot(a),
  perch_src: (a) => session.src(a.path),
  perch_list_src: () => session.listSrc(),
  perch_set_viewport: (a) => session.setViewport(a),
  perch_fetch_generator: (a) => session.fetchGenerator(a),
  perch_stop: () => session.stop(),
  perch_navigate: (a) => session.navigate(a),
  perch_upload_src: (a) => session.uploadSrc(a),
  perch_delete_src: (a) => session.deleteSrc(a),
  perch_ai_wake: (a) => session.aiWake(a),
  perch_ai_ask: (a) => session.aiAsk(a),
  perch_ai_read: (a) => session.aiRead(a),
  perch_ping: () => session.ping(),
  perch_ai_probe: (a) => session.aiProbe(a),
  perch_ai_status: () => session.aiStatus(),
  perch_doctor: () => session.doctor(),
  perch_export: (a) => session.exportZip(a),
  perch_think: (a) => session.think(a),
  perch_memory: (a) => session.memory(a),
  perch_todo: (a) => session.todo(a),
  perch_clock: (a) => session.clock(a),
  perch_calc: (a) => session.calc(a),
  perch_run_js: (a) => session.runJs(a),
  perch_web_fetch: (a) => session.webFetch(a),
  perch_web_search: (a) => session.webSearch(a),
  perch_skills: () => session.skills(),
};
