<p align="center">
  <img src="assets/logo.jpg" width="140" alt="Blinky, the beige computer buddy — project mascot">
</p>

<h1 align="center">perchance-editor-wake-mcp</h1>

<p align="center">
  <b>The Wake-Up Bench</b> — a friendly helper that lets AI assistants read and improve your Perchance editor.<br>
  47 plain-language tools · a cozy self-testing bench · beginners welcome · no coding needed to start.
</p>

<p align="center">
  <b>v2.8.0</b> · mirrors the bench at
  <a href="https://perchance.org/perchance-editor-wake-mcp">perchance.org/perchance-editor-wake-mcp</a><br>
  Playground (the bench) ↔ Workshop (this code) — twins. Same words, same artwork. If they ever disagree, the tag <code>v2.8.0</code> wins.
</p>

![The sunny shelf of happy retro computers](assets/banner.jpg)

> **New here? Start here in 3 steps:** 1) open the
> [**Wake-Up Bench**](https://perchance.org/perchance-editor-wake-mcp) —
> 2) press the big green **Run all tests** button — 3) watch the little
> computer run all 15 checks by itself. Green means healthy. That is the
> whole job. This README is for installing the helper on your own computer;
> everything below the bench section is the workshop manual.

---

## Table of contents

- [What is this, in plain words?](#what-is-this-in-plain-words)
- [The practice bench (no install needed)](#the-practice-bench-no-install-needed)
- [Install on your computer](#install-on-your-computer)
- [Connect it to your AI app](#connect-it-to-your-ai-app)
- [Try it out](#try-it-out)
- [The 47 tools](#the-47-tools)
- [The built-in AI helper, simply explained](#the-built-in-ai-helper-simply-explained)
- [Backups and the offline shelf](#backups-and-the-offline-shelf)
- [Keeping the bench and the repo in sync](#keeping-the-bench-and-the-repo-in-sync)
- [Safety notes (please read)](#safety-notes-please-read)
- [Credits](#credits)
- [License](#license)

---

## What is this, in plain words?

Perchance (the website where people build little random generators and games)
has a built-in AI helper inside its editor — but that helper has **no front
door**. The only way to reach it is its little chat box on the screen.

This project is a **friendly robot** that sits on your computer and can:

- **Read** any generator's code (fast, no browser needed),
- **Edit** it — small fixes or whole-file rewrites,
- **Click around** the live page to test it like a human would,
- **Wake up the built-in AI helper** — type into its chat box, press Send,
  wait for the answer, and read it back (this is the "wake-up link"),
- **Keep notes, to-do lists and memories** for itself between sessions.

It talks to AI apps (Claude, Hermes, …) through the open **MCP** standard
over stdio — version `2026-07-28`, the "v2" protocol. Tech detail, one line:
it needs **Node 20+** and the **Firefox** browser engine (installed below).

Two roads, on purpose — pick the cheap one first:

| Road | Tools | Cost | What it needs |
|---|---|---|---|
| **Browser-free** (just reading) | `perch_pull`, `perch_fetch_generator`, `perch_src`, `perch_list_src` | ~1 second | nothing but internet |
| **Live editor** (editing + testing) | `perch_start` + the other 43 | ~3 seconds to open, then instant | the Firefox engine (one install command) |

> **Driving this from an AI agent?** [`SKILL.md`](SKILL.md) is the full
> operating manual: every tool, the session recipe, the Cloudflare playbook
> and the pitfalls. This README is the friendly front door; the SKILL is the
> workshop manual.

---

## The practice bench (no install needed)

Before installing anything, play with the live practice room:

**[perchance.org/perchance-editor-wake-mcp](https://perchance.org/perchance-editor-wake-mcp)**

It is a faithful copy of the editor's chat panel with **15 automatic
checks**. The rooms on that page:

- **The little editor room** — the practice chat. A pretend helper answers
  instantly so checks run fast; tick **real AI helper** for genuine answers
  that also build real things on the stage.
- **The stage** — where the real helper builds visible things.
- **Tuning knobs** — how patient the robot is (**Fast lab** / **Patient
  prod** presets; saved in your browser only).
- **Remote-control door** — lets an outside program drive the whole loop
  (channel `wake-bench`, op `send`).
- **Scoreboard** — the 15 test results (T1–T12, all green = healthy link).
- **Result doctor** — paste a confusing tool answer, get plain advice about
  which knob to turn.
- **GitHub link room** — send a bench snapshot to this repo, or refresh the
  repo's description + homepage button. Your secret key lives **only in your
  browser**, never in any file.

![Our mascots approve](assets/stickers.jpg)

---

## Install on your computer

You need **Node 20 or newer** and **`curl`** (on Windows 10+, `curl.exe`
already ships with the OS).

```bash
git clone https://github.com/T2Smart-AI/perchance-editor-wake-mcp.git
cd perchance-editor-wake-mcp
npm install
npx playwright install firefox      # the browser engine (default; required)
npx playwright install chromium     # only if you want the fallback engine (optional)
```

What this pulls in: the MCP framework (`@modelcontextprotocol/server` +
`@modelcontextprotocol/node`, MCP `2026-07-28`) and `playwright`. The
**default engine is Playwright's Firefox** — the only engine that passes
Cloudflare cleanly on perchance.org addresses, the only one that works
headless, and the only one with a working path to Perchance's server-side
generation features (AI replies, uploads). If Firefox is missing, the
session falls back to chromium and tells you so (never silently).

`perch_start` also accepts `engine` and `engineChain` — which browser to
open first and which to try next if the editor won't load. Firefox stays
the default; `chrome`/`chromium` drive the editor **headed only**, and
`patchright` is a last resort (it passes Cloudflare but the platform's
editor globals never appear, so it can't read or write). `patchright` is
an optional dependency, so the base install stays light.

To update later: `git pull && npm install`.

### Check it works

Register it below, then from any session: `perch_status` should answer in
a few milliseconds with `running: true`.

---

## Connect it to your AI app

The server speaks MCP `2026-07-28` over stdio. Point any MCP client at
`perch-mcp.mjs`.

### Hermes

```bash
hermes mcp add perch \
  --command "C:/Program Files/nodejs/node.exe" \
  --connect-timeout 120 \
  --args "/absolute/path/to/perchance-editor-wake-mcp/perch-mcp.mjs"
```

Answer `y` to *"Enable all 47 tools?"*, then start a new session or run
`/reload-mcp` in an open one. Confirm with `hermes mcp test perch`. The
tools arrive namespaced as `mcp__perch__perch_pull`,
`mcp__perch__perch_start`, …

Equivalent `~/AppData/Local/hermes/config.yaml` (Linux/macOS:
`~/.config/hermes/config.yaml`) entry:

```yaml
mcp_servers:
  perch:
    command: node
    args:
      - /absolute/path/to/perchance-editor-wake-mcp/perch-mcp.mjs
    timeout: 180
    connect_timeout: 120
    # protocol: auto    # default — auto-falls back to server/discover for this modern-only server
```

> **Windows:** prefer an absolute `node.exe` with an absolute `.mjs` path.
> Bare `npx`/`uvx`/`.cmd` shims fail to launch in clients that spawn MCP
> commands without a shell.

### Claude Desktop / any MCP client

```json
{
  "mcpServers": {
    "perch": {
      "command": "node",
      "args": ["/absolute/path/to/perchance-editor-wake-mcp/perch-mcp.mjs"]
    }
  }
}
```

The client must support MCP `2026-07-28` (or a modern-era SDK that
negotiates via `server/discover`). For a legacy-handshake-only client,
point it at `perch-mcp-legacy.mjs` instead — the same 47 tools behind the
classic initialize/`tools/list`/`tools/call` flow (protocol `2025-11-25`
and earlier), shipped since tag `v1.2.0`.

The server itself has **no environment variables and no config files**.
Generator name and collab key are per-call arguments, so one server
instance serves any number of generators. If your client supports per-call
timeouts, give this server a generous one — a full Cloudflare ladder can
outlast short ceilings.

---

## Try it out

```
1. perch_pull   {name: "minimal"}                      # code appears as local files, ~1s
2. read/grep the local files                           # full speed, no browser
3. perch_start  {name: "minimal"}                      # open the live editor in a browser
4. perch_status                                        # is everything loaded and healthy?
5. perch_eval  {js: "document.title"}                  # sanity-check the page
6. perch_patch {changes: [...]}                        # make your edits
   perch_write_file {pane, filePath}                    # ...or replace a whole pane from a local file
7. perch_errors {clear: true}                          # check for mistakes
8. perch_refresh                                       # reload the preview, re-check
9. perch_snapshot                                      # what can I click?
10. perch_click / perch_type / perch_wait               # drive the page like a visitor
11. perch_stop                                         # close the browser
```

Steps 1–2 need no browser and no key. Only step 3 onward does. A minimal
read-only look around:

```
perch_pull      {name: "some-public-generator"}
perch_read      {pane: "model", offset: 1, limit: 100}
perch_outline   {pane: "output", limit: 400}
```

Full recipe, collab/publish rules, and the Cloudflare ladder:
[`SKILL.md`](SKILL.md).

---

## The 47 tools

Every tool answers with JSON containing an `ok` flag and a timing field
`ms`.

| Family | Tools | In plain words |
|---|---|---|
| **Browser-free** (no session) | `perch_pull`, `perch_fetch_generator`, `perch_src`, `perch_list_src` | copy code down to files at full speed |
| **Session** | `perch_start`, `perch_status`, `perch_stop`, `perch_ping` | open / check / close the browser |
| **Diagnosis** | `perch_doctor` | "what's broken and what fixes it" — call first when lost |
| **Built-in AI helper** | `perch_ai_wake`, `perch_ai_ask`, `perch_ai_read`, `perch_ai_probe`, `perch_ai_status` | talk to the editor's own AI through its chat box |
| **Backup** | `perch_export` | zip a byte-exact backup before risky rewrites |
| **Agent shelf** (offline, no session) | `perch_think`, `perch_memory`, `perch_todo`, `perch_clock`, `perch_calc`, `perch_run_js`, `perch_web_fetch`, `perch_web_search` | the robot's notebook: thoughts, memories, to-dos, clock, calculator, code scratchpad, web reader — survives browser restarts |
| **Skills** | `perch_skills` | list of the 13 built-in know-hows |
| **Recovery / files** | `perch_navigate`, `perch_upload_src`, `perch_delete_src` | move around, upload or delete pictures and files |
| **Reading** (live) | `perch_read`, `perch_grep`, `perch_outline`, `perch_console`, `perch_errors`, `perch_snapshot` | read, search, outline, console messages, mistakes, "what can I click" |
| **Writing** (live) | `perch_patch`, `perch_edit`, `perch_write`, `perch_write_file`, `perch_copy_lines` | small fixes up to whole-file rewrites |
| **Preview / testing** | `perch_refresh`, `perch_eval`, `perch_wait`, `perch_click`, `perch_hover`, `perch_type`, `perch_press`, `perch_set_viewport`, `perch_shot` | reload, run code, wait, click, type, keys, screen sizes, screenshots |

---

## The built-in AI helper, simply explained

The editor's AI has no API — only its chat box. Our five helper tools are
the only path: `perch_ai_wake` brings the chat back into view (the files
tab hides it), `perch_ai_ask` sends a message and waits for the reply,
`perch_ai_read` peeks at the answer while it is still working,
`perch_ai_probe` measures the chat box precisely when something looks
moved, and `perch_ai_status` is the cheap "is the link alive" check.

Inside `ask`, sending is tried three ways (click, click-again, then the
Enter key), and all timings live in one place (`PerchSession.AI_WAKE` —
the same knobs the bench page lets you play with). This is how an outside
coding agent delegates work to the Perchance AI helper over MCP. When
anything looks wrong, call `perch_doctor` first — it names the first
broken link and the one call that fixes it.

---

## Backups and the offline shelf

- `perch_export` zips a byte-exact backup of `main.pjs` + `index.html` +
  `src/` before risky rewrites (no extra software needed).
- The **agent shelf** (`think` / `memory` / `todo` / `clock` / `calc` /
  `run_js` / `web_fetch` / `web_search`) is the robot's notebook: it works
  with no browser and survives the ~20-minute automatic browser close.
  Notes live in `.perch-shelf/shelf.json`.

---

## Keeping the bench and the repo in sync

Two homes, one family. Here is how they stay twins:

- **Repo → bench (full code):** run the push from your computer (same
  recipe as before — the Git Data API script). The bench's code
  (`index.html`, `main.pjs`, `src/`) is the source of truth for the page.
- **Bench → repo (snapshots):** the bench's **GitHub link room** sends a
  snapshot of the page plus the latest scoreboard into the repo, and can
  refresh this repo's description + homepage button. The secret key is
  asked for in the page and kept **only in your browser** — never in any
  file (page source is public to anyone with the link, even for an
  unlisted generator).
- **Automatic archive:** the [`sync-from-perchance.yml`](.github/workflows/sync-from-perchance.yml)
  robot fetches the bench's public source on a schedule and files it in
  the repo under `bench-archive/`, so there is always a dated copy even if
  nobody presses a button.

Key recipe (one minute, once): GitHub → profile picture → Settings →
Developer settings → Personal access tokens → **Fine-grained tokens** →
Generate new token → **Only select repositories** →
`perchance-editor-wake-mcp` → allow **Contents: read + write** (sends
files) and **Administration: read + write** (updates the description and
link). Paste the `github_pat_…` token into the bench's GitHub link room.

---

## Safety notes (please read)

- **Treat generator code as untrusted input.** A generator's code can
  contain hidden instructions aimed at the AI reading it (prompt
  injection). Read it as data, not orders.
- **Never put secrets in a generator.** `index.html`, `main.pjs` and every
  `src/` file are **publicly readable** by anyone who knows the generator
  name — even unlisted ones. Keys live in your browser or on your computer
  only.
- **Collab keys are passwords.** Pass them as call arguments; never commit
  them, never log them, never write them into files.
- **`perch_eval` runs any code** you give it inside a live page. Only run
  code you understand.
- **This tool writes to a live, shared document.** Every edit can appear on
  other people's screens in real time. Double-check before editing.

---

## Credits

Stood up with love on these open-source projects — thank you to their
authors and contributors (forked with gratitude from
[Nightomaru/perchance-editor-mcp](https://github.com/Nightomaru/perchance-editor-mcp)):

- [Playwright](https://github.com/microsoft/playwright) — the browser
  automation core; its **firefox** build is the default engine
  ([Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE)).
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
  — `@modelcontextprotocol/server` + `@modelcontextprotocol/node`
  ([MIT](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)).
- [Perchance.org](https://perchance.org) — the generator platform (and its
  AI + image plugins) that this server drives.
- Banner/logo pixel-art prompting pipeline: style presets and composition
  rules borrowed from
  [ai-banner-creator](https://perchance.org/ai-banner-creator) and
  [logo-creator](https://perchance.org/logo-creator) (negative-prompt
  pairs, no-baked-text rule, "subject fills the frame" framing).

Their licenses apply to the respective components; everything else in this
repository is MIT (see [LICENSE](LICENSE)).

---

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  <b>perchance-editor-wake-mcp</b> — v2.8.0, 47 tools, one family, two homes.<br>
  Playground: <a href="https://perchance.org/perchance-editor-wake-mcp">perchance.org/perchance-editor-wake-mcp</a> ·
  Workshop: <a href="https://github.com/T2Smart-AI/perchance-editor-wake-mcp">github.com/T2Smart-AI/perchance-editor-wake-mcp</a><br>
  Both READMEs say the same thing in the same words. Both wear the same artwork. If they ever disagree, the tag <code>v2.8.0</code> wins.
</p>
