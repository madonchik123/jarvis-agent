# Jarvis — a free, open-source voice AI agent for Windows

🇷🇺 [Русская версия](README.md) · 🇬🇧 English

An always-on desktop assistant in the spirit of the MCU J.A.R.V.I.S. Say **«Джарвис»** / **"Jarvis"** and it listens, thinks with a real
coding-grade **agent** ([opencode](https://opencode.ai)), talks back in a Jarvis voice, **sees your screen and drives any Windows
app** (Codex-style computer use), points at things while it speaks, remembers you, learns voice commands, and plugs into
**Gmail / Calendar / Notion / GitHub / …** through MCP connectors.

* **Free to run**: speech recognition is fully on-device, the agent works with opencode's free models (no key needed), and the Jarvis voice is free too.
* **Bilingual**: Russian + English everywhere (recognition, voice, UI).
* **Light**: heavy parts load on demand and unload when idle (~0.9 GB across all processes with the agent loaded, ~0.4 GB while it sleeps).
* **Yours**: MIT licence, no telemetry, bring any model/provider, auto-updates from GitHub Releases.

```
Electron 45 · React 19 · TypeScript · Framer Motion
sherpa-onnx (Silero VAD · streaming RU gate · GigaAM-RU · Parakeet-EN)  ·  free Jarvis voice server / Fish Audio / Piper / XTTS-v2
opencode serve (agent)  ·  MCP tools & connectors  ·  jarvis-native (C#: UI Automation · SendInput · OCR)  ·  vision helper
```

> Unofficial fan project. "J.A.R.V.I.S." is a Marvel character name; this project is not affiliated with Marvel or Disney.

---

## Contents

1. [What it can do](#what-it-can-do)
2. [Requirements](#requirements)
3. [Install](#install)
4. [First run](#first-run)
5. [Using Jarvis](#using-jarvis)
6. [Settings guide](#settings-guide)
7. [AI providers & models](#ai-providers--models)
8. [Voices](#voices)
9. [Connectors (Gmail, Calendar, Notion, GitHub…)](#connectors-gmail-calendar-notion-github)
10. [Computer use & system control](#computer-use--system-control)
11. [Documents & presentations](#documents--presentations)
12. [Speech recognition](#speech-recognition)
13. [Voice commands (routines) and memory](#voice-commands-routines-and-memory)
14. [Updates](#updates)
15. [Resource use](#resource-use)
16. [Troubleshooting](#troubleshooting)
17. [Privacy & safety](#privacy--safety)
18. [Development](#development)
19. [Licence](#licence)

---

## What it can do

| | |
|---|---|
| **Wake word, always on** | Silero VAD gates a tiny streaming recogniser; GigaAM-RU verifies. Any phrase works (Settings), no training, no key. Confirms with a spoken «Да, сэр» / "Yes, sir?". Hotkey **Ctrl+Alt+J** works too. |
| **Fast local speech recognition** | Russian → GigaAM v3, English → Parakeet-TDT 110M (or Whisper). Quiet-mic gain normalisation, two-recogniser wake verification, adaptive end-of-speech, dictation over a minute long. |
| **A real agent with a character** | opencode with a custom `jarvis` agent: shell, files, web, MCP tools, permission levels (ask / auto-confirm-risky / full). The persona is the film Jarvis — composed, precise, dry wit, "sir". Works with free models out of the box; 230+ providers via your own key. |
| **Computer use in any app** | A native **C# engine** (`jarvis-native.exe`) modelled on the documented Codex computer-use window API: windows by id, an **indexed accessibility tree** plus an occlusion-proof screenshot per window (`get_app_state`), then `click` / `set_value` / `type_text` / `press_key` / `scroll` / `drag` / `paste` / `perform_secondary_action` — each activates its window and waits for the UI to settle, returning the refreshed tree. Fallbacks for apps without accessibility (Telegram, Discord, games): OCR screen map, `click_text`, `type`, wheel scroll, mouse, held keys and timed **key/mouse sequences**. A vision model can read icons and images. |
| **System control** | Instant commands without the model («громче», «пауза», «следующий трек», «сверни все окна», "volume 40"), plus tools for the agent: master and per-app **volume**, media keys, **window** move / resize / snap / minimise / close / topmost, show desktop, lock, brightness. |
| **Documents & presentations** | "Write my coursework on…", "make a 10-slide deck about…", "fix the introduction in this file": real **DOCX** (Word styles, title page, table of contents, captions, page numbers; Russian GOST template for coursework), designed **PPTX** decks (6 themes, 11 layouts, speaker notes), **PDF**; finds free-licence **photos** (credited) and draws **diagrams and charts** itself; reads DOCX / PDF / PPTX / XLSX and edits DOCX in place without breaking its formatting; converts through Word / PowerPoint / LibreOffice when installed. |
| **Highlight while speaking** | `jarvis_say(highlight=[{find:"Settings"}])` outlines the thing on every monitor while the sentence is spoken. |
| **Follow-up questions** | The agent can *ask* you something; the mic opens immediately and you can answer by voice, or tap/type the answer on the HUD or in the chat. |
| **Spoken output = the gist** | The model chooses a short spoken line; the full answer stays on screen (collapsed), with a *Thinking* pill and a **Process** drawer (reasoning + timed tool steps). |
| **Live activity** | A live step list with timers shows what Jarvis is doing right now ("Clicking element 34 in Calculator… · step 6"), not just a spinner. |
| **Voices** | **Server (free)** — the Jarvis voice from a shared server, nothing to set up; **Own key** — your Fish Audio key; **Local** — Piper or an optional locally fine-tuned XTTS clone (GPU). Automatic fallback to Piper. |
| **Connectors (MCP)** | One-click catalogue: Gmail, Google Calendar/Drive/Docs/Sheets, Notion, Linear, GitHub, Context7, DeepWiki, Brave, Playwright, Filesystem… or any custom MCP server. Reading is free, writing asks first. |
| **Memory & chats** | Durable facts injected every turn (editable page); chat threads with auto-new-chat after idle; «новый диалог» by voice. |
| **Voice-editable commands** | "Jarvis, create a command *Hello*: open Spotify and say good morning" — runs instantly without the model. Steps: say, open, focus window, **click** (text or x,y; right / double), type (per-character delay), keys, **hold key**, **scroll**, move mouse, wait, run PowerShell, ask Jarvis — each with an optional **delay after**. Edited on the Commands page or by voice. |
| **Safety** | Consent once per chat for computer control, glowing screen edge + badge while controlling, **Ctrl+Alt+K** kill switch, loop guard, true cancellation. |
| **Auto-update** | The installed app checks GitHub Releases, tells you about a new version and installs it on request (or automatically). |

## Requirements

* **Windows 10/11 x64.** macOS and Linux are **not supported yet**: computer use, OCR, window control and audio control rely on Windows APIs (UI Automation / Windows OCR / SendInput / Core Audio), so there are no installers for those systems. A port is possible but is a separate piece of work — contributions welcome.
* A microphone. ~1 GB free RAM, ~1 GB disk (speech models are downloaded on first run, ~350 MB core).
* For development: **Node.js 22+**, Git and the **.NET SDK 8+** (it builds the native helper; the installed app needs only the .NET Framework 4.8 that ships with Windows).
* Optional: **uv** (<https://docs.astral.sh/uv>) or **Node.js** on your PATH for connectors that run locally; an NVIDIA GPU (≥ 6 GB VRAM) only for the XTTS clone.
* To read Russian text on screen (OCR) add the Russian language pack in Windows (Settings → Time & language).

## Install

### Option A — installer
Download `Jarvis-Setup-x.y.z.exe` from the repository's **[Releases](https://github.com/madonchik123/jarvis-agent/releases)** and run it. The installer is unsigned, so Windows SmartScreen may warn: *More info → Run anyway*. Everything it needs ships inside (opencode, the C# engine, the VC++ runtime for Piper); the speech models (~530 MB) download by themselves on first launch with no clicks: progress shows in the setup window, you can use Jarvis meanwhile, and a dropped connection is retried. After that the app updates itself (with your consent).

### Option B — from source
```bash
git clone https://github.com/madonchik123/jarvis-agent.git
cd jarvis-agent
npm install
npm run native     # builds resources/native/jarvis-native.exe (C#)
npm run models     # core speech models (~350 MB) into %APPDATA%\Jarvis\models  (or let the in-app first-run setup do it)
npm run dev        # run in development
```
Build the installer yourself: `npm run dist` → `release/Jarvis-Setup-x.y.z.exe`.

## First run

1. Start Jarvis. If speech models are missing it offers to download them (Settings → *Models & storage* lists everything).
2. The **AI agent** works immediately with free opencode models. For more/better models paste your key in *Settings → AI agent* (see [providers](#ai-providers--models)).
3. The voice is **Server (free)** by default — nothing to configure. Switch in *Settings → Voice* if you prefer your own key or fully local voices.
4. Say **«Джарвис, привет»** or press **Ctrl+Alt+J**. Emergency stop: **Ctrl+Alt+K**.

## Using Jarvis

Say the wake word, then your request — in one breath or after the confirmation:

* *"Jarvis, open the calculator and multiply twelve by seven."*
* *"Jarvis, what's on my screen? Show me where the settings button is."* (it outlines it)
* *«Джарвис, сделай потише»* · *"pause"* · *«сверни все окна»* — instant, no model involved
* *"Jarvis, put the browser on the left half and Telegram on the right."*
* *"Jarvis, remember that I'm working on project Atlas."*
* *"Jarvis, read my unread email"* (with the Gmail connector)
* *"Jarvis, create a command *Evening*: turn the music down and say goodnight."*
* *«Новый диалог»* — fresh chat. *«Стоп»* — cancel the current task.

You can also type in the chat. Permission requests and questions appear both on the always-on-top HUD and in the chat; answering either closes both.

## Settings guide

Settings is split into sections:

| Section | What is there |
|---|---|
| **General** | Accent colour, theme, interface language, HUD corner, subtitles, autostart. |
| **AI agent** | Provider + API key (with *Get API key* buttons), model picker or any model id, vision model (auto = current model if it can see images), permission level, **agent idle unload**, auto-new-chat timeout, working folder, your standing instructions. |
| **Connectors** | Add / sign in / disable MCP services — see below. |
| **Listening** | Wake phrases, sensitivity, "Yes, sir" confirmation, follow-up window, microphone, recogniser, hotkey. |
| **Voice** | Source (Server free / Own key / Local), voices + preview, speed, volume, effects. |
| **Models & storage** | On-device speech models (download / installed), OCR languages. |
| **About** | Version, **updates**, memory use, open logs, copy diagnostics. |

## AI providers & models

* **opencode Zen (default)** — free models such as `deepseek-v4.1-flash-free` and `glm-5.3-flash-free` work without a key. An opencode key (<https://opencode.ai/auth>) unlocks the rest.
* **Any provider** — *Settings → AI agent → provider*: OpenRouter, OpenAI, Anthropic, Google, DeepSeek, Groq, xAI, Mistral, Together, Cerebras… (230+ through opencode). Each has a *Get API key* button; the key is stored by opencode in Jarvis' private data dir.
* **Your own endpoint** — "Custom OpenAI-compatible endpoint" (Ollama, LM Studio, vLLM, any gateway): base URL + key + model ids.
* **Vision** — models that accept images (GLM 5.3, DeepSeek V4.1, GPT-4o, Claude, Gemini…) let Jarvis look at screenshots directly; otherwise a free VL model is used for `ask_screen`.

## Voices

| Source | Setup | Notes |
|---|---|---|
| **Server (free)** (default) | Nothing — pick it in *Settings → Voice*. The Jarvis voice comes from a shared server that spreads load over a pool of keys. | Cloud: spoken sentences are sent to the server and Fish Audio. Rate-limited per installation (requests per minute). Falls back to Piper on any error. The server is a separate (private) project, `jarvis-tts-server`; *Advanced → Voice server URL* lets you point at your own deployment. |
| **Own key** | Get a free key at <https://fish.audio/app/api-keys> (button in *Settings → Voice*) and paste it. RU/EN Jarvis voice ids and the model `s2.1-pro-free` are pre-filled. | Cloud: sentences go straight to api.fish.audio. |
| **Local** | Piper voices are downloaded in *Models & storage*; the XTTS clone is optional (see [`voice/`](voice)). | Fully offline. XTTS-v2 is **non-commercial** (CPML); use clips you have the right to use — weights are not distributed. |

## Connectors (Gmail, Calendar, Notion, GitHub…)

*Settings → Connectors* lets you plug [MCP](https://modelcontextprotocol.io) servers into the agent. Each connector adds tools named
`<service>_*`; **reading/searching runs freely, anything that writes, sends or deletes asks for confirmation** (unless you chose *full autonomy*), and the agent is told to confirm irreversible actions out loud.

**Add one:** pick it in the catalogue → fill what it asks for → *Add*. The agent restarts and the connector appears with a status chip. For services that use browser login press **Sign in** and finish in the browser; tokens are kept by opencode in Jarvis' data dir.

| Connector | How it authenticates |
|---|---|
| Notion, Linear, Sentry | Browser sign-in (OAuth) — nothing to prepare |
| GitHub | Personal access token (the button opens the token page) |
| Context7, DeepWiki, Grep, Parallel Search | No key |
| Brave Search | API key |
| Filesystem, Playwright, Fetch | Run locally via `npx` / `uvx` (needs Node.js / uv) |
| **Gmail, Calendar, Drive, Docs, Sheets** | Google's official remote MCP servers (Developer Preview) — needs **your own Google Cloud OAuth client**, see below |
| Google Workspace (community) | `uvx workspace-mcp` — one local server for Gmail + Calendar + Drive + Docs, your own OAuth *Desktop* client |
| **Custom** | Any remote URL (+ headers) or any local command (+ env vars) |

### Gmail & Google Calendar setup (official servers)

1. In [Google Cloud Console](https://console.cloud.google.com) create/select a project and join the Workspace MCP *Developer Preview* (<https://developers.google.com/workspace/guides/configure-mcp-servers>).
2. Enable the **Gmail API** / **Google Calendar API** and their MCP services (`gmailmcp.googleapis.com`, `calendarmcp.googleapis.com`).
3. *Google Auth Platform → Clients → Create client*: type **Web application**, tick **"Use this client for an AI-powered agent"**, and add the redirect URI
   `http://127.0.0.1:19876/mcp/oauth/callback`. Configure the consent screen (External + yourself as a test user is fine).
4. In Jarvis: *Connectors → Gmail* → paste the **Client ID** and **Client secret** (scopes are pre-filled) → *Add* → *Sign in* and approve in the browser.

Prefer something simpler? Use **Google Workspace (community)**: create an OAuth client of type *Desktop app*, enable the APIs, paste ID + secret; the Google login opens on first use.

Secrets (API keys, client secrets) are stored in `%APPDATA%\Jarvis\settings.json` on your machine only.

## Computer use & system control

On first use in a chat Jarvis asks permission once ("I need to see the screen and control mouse and keyboard — allow for this chat?"). While it controls the PC the screen edge glows and a badge shows; **Ctrl+Alt+K** stops everything instantly.

Tools the agent has (all prefixed `jarvis_`):

* **Windows by id (preferred)**: `list_apps`, `get_app_state` (accessibility tree + screenshot, works while the window is covered), `click`, `set_value`, `type_text`, `press_key`, `scroll`, `drag`, `paste`, `perform_secondary_action` — each activates its window, waits for the UI to settle and returns the refreshed tree. Key names accept both `ctrl+shift+t` and X11 keysyms (`Control_L+Shift_L+t`, `Return`, `Page_Down`).
* **Any app, pixel level**: `screen` (OCR + UIA map with stable item numbers), `click_text`, `act`, `ask_screen` (vision), `type` (real Unicode keystrokes: focus + click field + type + Enter), `keys` (chords / media keys), `scroll_at` (mouse wheel anywhere), `mouse` (click / double / right / middle / move / down / up / drag, ctrl/shift modifiers), `hold_key`, `sequence` (timed steps, e.g. hold **W** 500 ms → wait → **Enter**; `scan:true` for games).
* **Waiting**: `wait` (until the screen settles), `wait_for` (until text / window appears) — so it never spams retries while a page loads.
* **Apps & windows**: `open_app`, `open_url`, `focus_window`, `windows`, `highlight`, clipboard.
* **System**: `volume` (master / per app), `media`, `window_control` (move, resize, snap, minimise, maximise, close, topmost), `desktop` (show desktop, lock, screen off, brightness).

The engine is `native/JarvisNative` (C#, .NET Framework 4.8, ~70 KB exe, starts in ~0.2 s): UI Automation with cached property reads, `PrintWindow` capture that works for covered windows, SendInput with layout-independent key names, Windows OCR (Russian + English), Core Audio for volume. Protocol: JSON lines on stdin/stdout (`scripts/test-native.mts` is a smoke test).

## Documents & presentations

Just ask: "write a report on…", "make a 10-slide deck for my defence", "read this PDF and summarise it", "add a methods section to my coursework", "save it as PDF". Files go to **Documents\Jarvis** (or wherever you say) and are opened for you.

| Tool | What it does |
|---|---|
| `doc_create` | DOCX (or PDF) from structure: headings, paragraphs with **bold** / *italic*, lists, tables and figures with auto-numbered captions, quotes, call-outs, references. Templates: **gost** (Russian university rules: Times New Roman 14, 1.5 spacing, 1.25 cm indent, margins 30/15/20/20 mm, chapters on a new page, title page, table of contents, page numbers), **academic**, **modern**, **business**. When Word is installed it fills the table of contents with real page numbers. |
| `slides_create` | 16:9 PPTX: themes *midnight, ocean, forest* (dark) and *clean, warm, mono* (light); layouts: title, section, bullets (+ photo or diagram), two columns, stats, quote, full-bleed photo, diagram / chart, table, timeline, closing; speaker notes. Optional PDF copy. |
| `image_search` | Real photos and illustrations under free licences (Wikimedia Commons, Openverse): public domain / CC0 / CC BY / CC BY-SA only, downloaded right away, each with a ready credit line that goes into the figure caption or onto the slide. |
| `diagram_create` | Diagrams and charts from Mermaid: flowcharts, sequences, timelines, mind maps, Gantt, pie, bar and line charts — in the document or deck theme colours, at 2× resolution. `doc_create` and `slides_create` also take the Mermaid code inline. |
| `doc_read` | Reads DOCX, PDF, PPTX, XLSX, TXT, MD, CSV, HTML; DOCX paragraphs are numbered for edits. |
| `doc_edit` | Edits an existing DOCX in place, keeping its formatting: replace text, rewrite a paragraph, insert paragraphs / headings / bullets, delete. A backup goes to `Documents\Jarvis\.backups`. PPTX: text replacement. |
| `doc_convert` | Through the installed Word / PowerPoint / Excel (or LibreOffice): to PDF, PDF to editable DOCX, legacy .doc / .ppt / .xls to modern formats. Without Office, DOCX → PDF still works (simplified layout). |

All generators work without Office; Office or LibreOffice is only needed for exact conversions and filling the table of contents.

## Speech recognition

* **Russian → GigaAM v3** (punctuated CTC), **English → Parakeet-TDT 110M**; Silero VAD + a streaming recogniser gate the wake word.
* Benchmarked on Fish-synthesised RU / EN / mixed speech (`scripts/bench-stt.mts`): GigaAM writes English brand names in Latin inside Russian sentences («открой Spotify и включи Daft Punk») where the multilingual Parakeet-v3 transliterates them; Parakeet-110M beats Parakeet-v3 on English (1–3 % vs 4–6 % WER) at a quarter of the size. So the pair stays — no 465 MB multilingual model needed.
* **Long dictation**: a minute of speech decodes in one pass with no loss (`scripts/bench-long.mts`). The end-of-speech pause adapts to the sentence length (short command ≈ 0.7 s, long request up to 1.5 s) and utterances can run for over a minute.
* The recognisers load only when a command is actually coming (wake word heard / follow-up window open), not for every sound in the room.

## Voice commands (routines) and memory

* *"Jarvis, create a command *Привет*: open Spotify and say good morning."* — stored as a routine. When you say the phrase it runs instantly, without the model. Re-saving a name edits it; delete by voice or on the **Commands** page. Steps: `say`, `open`, `focus`, `click`, `type`, `keys`, `hold`, `scroll`, `move`, `wait`, `run`, `agent`; every step has an optional delay after it.
* **Memory** page: durable facts Jarvis knows about you (editable, pinnable). They are injected every turn; routines are *not* stored as memory.

## Updates

The installed app checks GitHub Releases (20 s after start, then every 6 h). *Settings → About → Updates*: **Ask me** (a "new version available — update?" dialog), **Download automatically**, or **Never check**. Once an update is downloaded Jarvis asks whether to restart now; choose *Later* and it installs the next time you quit. Releases are produced by the `Release` workflow when a `v*` tag is pushed.

## Resource use

* The agent server (the largest process) **unloads after 10 idle minutes** and restarts in a few seconds when you speak (Settings → AI agent).
* GPU, network and audio services run inside the main process and the HUD window also hosts the microphone, so there are only two Electron renderers.
* ASR models live in a **child process** started when a command is coming and stopped after a minute idle (returns ~500 MB).
* The cloned-voice engine (XTTS, GPU) unloads after N idle minutes (default 10); until it is ready Jarvis uses Piper.
* The native helper trims its working set when idle; the main window is destroyed when closed to the tray.

Typical: ~0.9 GB across all processes with the agent loaded (~0.4 GB while it sleeps).

## Troubleshooting

| Symptom | Try |
|---|---|
| Something is off | *Settings → About → Open logs / Copy diagnostics* (`%APPDATA%\Jarvis\logs\jarvis.log`). |
| Stuck on "Listening" / doesn't hear the wake word | Check the microphone in *Settings → Listening*; raise sensitivity; make sure the speech models are installed. |
| No voice / robotic voice | The free voice server may be down or rate-limiting you → Jarvis falls back to Piper; install Piper voices in *Models & storage*, or use your own Fish key. |
| Typing goes to the wrong app | Jarvis focuses the app before sending keys; use `jarvis_type` with `app`. Games may need `scan:true`. |
| Russian on screen is read badly | Add the Russian language pack in Windows (OCR uses installed languages). |
| A connector says *Sign-in needed* | Press **Sign in** and finish in the browser; for Google check the redirect URI `http://127.0.0.1:19876/mcp/oauth/callback`. |
| Local connector *Failed* | It needs Node.js (`npx`) or uv (`uvx`) on PATH. |
| The HUD is not visible | It sits in the corner chosen in *General*; it hides only while the main window is focused over it. |
| Cloned voice errors | Needs an NVIDIA GPU with ~5 GB free VRAM; Jarvis falls back to Piper. |

## Privacy & safety

* All speech recognition runs on your PC. No telemetry.
* Network traffic: your chosen model endpoint, one-time model downloads (GitHub / Hugging Face), connectors you enable, update checks (GitHub), image searches for documents (the query text goes to Wikimedia Commons / Openverse), and — only with a cloud voice — the sentences Jarvis speaks (to the free voice server / Fish Audio). The free server sees the text and a random per-installation id, nothing else.
* Risky shell patterns always ask; computer control is consent-gated per chat; connector writes ask first; **Ctrl+Alt+K** is a global kill switch.
* Screenshots taken for vision are sent to the model you selected — pick a local/endpoint model if that matters.

## Development

```bash
npm run dev        # electron-vite dev server
npm run native     # C# helper → resources/native/jarvis-native.exe
npm run typecheck
npm test           # unit tests (tsx --test)
npm run build
npm run dist       # unsigned NSIS installer in release/
```

Layout: `src/main` (assistant orchestrator, opencode server manager, MCP tool server, computer-use layer, speech engine, TTS, updater), `src/renderer` (React UI: assistant, commands, memory, settings, HUD, overlays), `src/shared` (types, connector catalogue, routine steps), `native/JarvisNative` (C# computer-use engine), `resources/bridge.ps1` (PowerShell fallback bridge), `voice/` (optional clone tooling), `promo/` (the scripts that produced the promo video), `scripts/` (benchmarks and smoke tests).

Debug helpers are environment-gated (`JARVIS_SHOTS`, `JARVIS_TEST_*`, `JARVIS_USERDATA`, `JARVIS_PROMO`) in `src/main/index.ts`.

Contributions are welcome — issues and PRs about new connectors (add an entry in `src/shared/connectors.ts`), voices, and computer-use reliability are especially useful.

## Licence

MIT (this project). Third-party components and models keep their own licences — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Note XTTS-v2 is non-commercial, and film-character voices may be protected: use cloned voices for personal use only.
