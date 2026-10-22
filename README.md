# Jarvis — a free, open-source voice AI agent for Windows

An always-on desktop assistant in the spirit of the MCU J.A.R.V.I.S. Say **«Джарвис»** / **"Jarvis"** and it listens, thinks with a real
coding-grade **agent** ([opencode](https://opencode.ai)), talks back in a Jarvis voice, **sees your screen and drives any Windows
app** (Codex-style computer use), points at things while it speaks, remembers you, learns voice commands, and plugs into
**Gmail / Calendar / Notion / GitHub / …** through MCP connectors.

* **Free to run**: speech recognition is fully on-device, and the agent works with opencode's free models (no key needed).
* **Bilingual**: Russian + English everywhere (recognition, voice, UI).
* **Light**: heavy parts load on demand and unload when idle (~250 MB for Jarvis itself, ~1 GB total across all processes).
* **Yours**: MIT licence, no telemetry, bring any model/provider.

```
Electron 45 · React 19 · TypeScript · Framer Motion
sherpa-onnx (Silero VAD · streaming RU gate · GigaAM-RU · Parakeet-EN)  ·  Fish Audio / Piper / optional XTTS-v2 clone
opencode serve (agent)  ·  MCP tools  ·  Open Computer Use (accessibility)  ·  Windows OCR + vision
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
10. [Computer use](#computer-use)
11. [Voice commands (routines) and memory](#voice-commands-routines-and-memory)
12. [Resource use](#resource-use)
13. [Troubleshooting](#troubleshooting)
14. [Privacy & safety](#privacy--safety)
15. [Development](#development)
16. [Licence](#licence)

---

## What it can do

| | |
|---|---|
| **Wake word, always on** | Silero VAD gates a tiny streaming recogniser; GigaAM-RU verifies. Any phrase works (Settings), no training, no key. Confirms with a spoken «Да, сэр» / "Yes, sir?". Hotkey **Ctrl+Alt+J** works too. |
| **Fast local speech recognition** | Russian → GigaAM v3, English → Parakeet-TDT 110M (or Whisper). Quiet-mic gain normalisation, two-recogniser wake verification, energy-based end-of-speech so it never gets stuck "listening". |
| **A real agent** | opencode with a custom `jarvis` agent: shell, files, web, MCP tools, permission levels (ask / auto-confirm-risky / full). Works with free models out of the box; 230+ providers via your own key. |
| **Computer use in any app** | Accessibility-tree control through **Open Computer Use** (click, set_value, type, press_key, scroll, drag…) plus pixel-level fallbacks for apps with no accessibility (Telegram, Discord, games): OCR screen map, `click_text`, `type`, wheel scroll, mouse, held keys and timed **key/mouse sequences**. A vision model can read icons and images. |
| **Highlight while speaking** | `jarvis_say(highlight=[{find:"Settings"}])` outlines the thing on every monitor while the sentence is spoken. |
| **Follow-up questions** | The agent can *ask* you something; the mic opens immediately and you can answer by voice, or tap/type the answer on the HUD or in the chat. |
| **Spoken output = the gist** | The model chooses a short spoken line; the full answer stays on screen (collapsed), with a *Thinking* pill and a **Process** drawer (reasoning + timed tool steps). |
| **Voices** | **Fish Audio** cloud Jarvis voices (RU + EN), local **Piper**, or an optional locally fine-tuned **XTTS-v2** clone (GPU). Automatic fallback chain to Piper. |
| **Connectors (MCP)** | One-click catalogue: Gmail, Google Calendar/Drive/Docs/Sheets, Notion, Linear, GitHub, Context7, DeepWiki, Brave, Playwright, Filesystem… or any custom MCP server. Reading is free, writing asks first. |
| **Memory & chats** | Durable facts injected every turn (editable page); chat threads with auto-new-chat after idle; «новый диалог» by voice. |
| **Voice-editable commands** | “Jarvis, create a command *Hello*: open Spotify and say good morning” — runs instantly without the model; edit/delete by voice. |
| **Status that means something** | While working the HUD shows what it is actually doing (“Opening roblox.com… · step 3”), not just a spinner. |
| **Safety** | Consent once per chat for computer control, glowing screen edge + badge while controlling, **Ctrl+Alt+K** kill switch, loop guard, true cancellation. |

## Requirements

* **Windows 10/11 x64.** macOS and Linux are **not supported yet**: computer use, OCR, window control and the Open Computer Use backend rely on Windows APIs (UI Automation / Windows OCR / SendInput), so there are no installers for those systems. A port is possible but is a separate piece of work — contributions welcome.
* A microphone. ~1 GB free RAM, ~1 GB disk (speech models are downloaded on first run, ~350 MB core).
* For development: **Node.js 22+** and Git.
* Optional: **uv** (<https://docs.astral.sh/uv>) or **Node.js** on your PATH for some connectors that run locally; an NVIDIA GPU (≥6 GB VRAM) only for the XTTS clone.
* For voice in Russian OCR on screen: add the Russian language pack in Windows (Settings → Time & language).

## Install

### Option A — installer
Download `Jarvis Setup x.y.z.exe` from the repository's **Releases** (or the latest CI run's artifact) and run it. The installer is unsigned, so Windows SmartScreen may warn: *More info → Run anyway*.

### Option B — from source
```bash
git clone https://github.com/madonchik123/jarvis-agent.git
cd jarvis-agent
npm install
npm run models     # core speech models (~350 MB) into %APPDATA%\Jarvis\models  (or let the in-app first-run setup do it)
npm run dev        # run in development
```
Build the installer yourself: `npm run dist` → `release/Jarvis Setup x.y.z.exe`.

## First run

1. Start Jarvis. If speech models are missing it offers to download them (Settings → *Models & storage* lists everything).
2. **AI agent** works immediately with free opencode models. For more/better models paste your key in *Settings → AI agent* (see [providers](#ai-providers--models)).
3. Pick a voice in *Settings → Voice* (Fish Audio needs a free key; Piper works offline with no key).
4. Say **«Джарвис, привет»** or press **Ctrl+Alt+J**. Emergency stop: **Ctrl+Alt+K**.

## Using Jarvis

Say the wake word, then your request — in one breath or after the confirmation:

* *«Джарвис, открой калькулятор и посчитай 12 умножить на 7»*
* *"Jarvis, what's on my screen? Show me where the settings button is."* (it outlines it)
* *«Можешь посмотреть, сколько у меня Робуксов?»* (opens the site, reads the page, answers)
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
| **AI agent** | Provider + API key (with *Get API key* buttons), model picker or any model id, vision model (auto = current model if it can see images), permission level, auto-new-chat timeout, working folder, your standing instructions. |
| **Connectors** | Add/sign in/disable MCP services — see below. |
| **Listening** | Wake phrases, sensitivity, "Yes, sir" confirmation, follow-up window, microphone, recogniser, hotkey. |
| **Voice** | Engine (Fish / Piper / local clone), voices + preview, speed, volume, effects, Fish credentials. |
| **Models & storage** | On-device speech models (download/installed), OCR languages. |
| **About** | Version, memory use, open logs, copy diagnostics. |

## AI providers & models

* **opencode Zen (default)** — free models such as `deepseek-v4.1-flash-free` and `glm-5.3-flash-free` work without a key. An opencode key (<https://opencode.ai/auth>) unlocks the rest.
* **Any provider** — *Settings → AI agent → provider*: OpenRouter, OpenAI, Anthropic, Google, DeepSeek, Groq, xAI, Mistral, Together, Cerebras… (230+ through opencode). Each has a *Get API key* button; the key is stored by opencode in Jarvis' private data dir.
* **Your own endpoint** — "Custom OpenAI-compatible endpoint" (Ollama, LM Studio, vLLM, any gateway): base URL + key + model ids.
* **Vision** — models that accept images (GLM 5.3, DeepSeek V4.1, GPT-4o, Claude, Gemini…) let Jarvis look at screenshots directly; otherwise a free VL model is used for `ask_screen`.

## Voices

| Engine | Setup | Notes |
|---|---|---|
| **Fish Audio** (default) | Get a free key at <https://fish.audio/app/api-keys> (button in *Settings → Voice*), paste it. RU/EN Jarvis voice ids and the model `s2.1-pro-free` are pre-filled. | Cloud: spoken sentences are sent to api.fish.audio. Falls back to Piper on any error. |
| **Piper** | Download the voices in *Models & storage*. | Fully offline, instant, lighter quality. |
| **XTTS clone** (optional, GPU) | See [`voice/`](voice) — prepare a dataset from your own clips (`prep_dataset.py`), evaluate (`eval_mel.py`), light fine-tune (`ft_xtts.py`, fits an 8 GB GPU), install with `voice/install-clone.ps1`. | XTTS-v2 is **non-commercial** (CPML). Use clips you have the right to use; weights are not distributed. |

## Connectors (Gmail, Calendar, Notion, GitHub…)

*Settings → Connectors* lets you plug [MCP](https://modelcontextprotocol.io) servers into the agent. Each connector adds tools named
`<service>_*`; **reading/searching runs freely, anything that writes, sends or deletes asks for confirmation** (unless you chose *full autonomy*), and the agent is told to confirm irreversible actions out loud.

**Add one:** pick it in the catalogue → fill what it asks for → *Add*. The agent restarts and the connector appears with a status chip. For services that use browser login press **Sign in** and finish in the browser; tokens are kept by opencode in Jarvis' data dir.

| Connector | How it authenticates |
|---|---|
| Notion, Linear, Sentry | Browser sign-in (OAuth) — nothing to prepare |
| GitHub | Personal access token (button opens the token page) |
| Context7, DeepWiki, Grep, Parallel Search | No key |
| Brave Search | API key |
| Filesystem, Playwright, Fetch | Run locally via `npx`/`uvx` (needs Node.js / uv) |
| **Gmail, Calendar, Drive, Docs, Sheets** | Google's official remote MCP servers (Developer Preview) — needs **your own Google Cloud OAuth client**, see below |
| Google Workspace (community) | `uvx workspace-mcp` — one local server for Gmail + Calendar + Drive + Docs, your own OAuth *Desktop* client |
| **Custom** | Any remote URL (+ headers) or any local command (+ env vars) |

### Gmail & Google Calendar setup (official servers)

1. In [Google Cloud Console](https://console.cloud.google.com) create/select a project and join the Workspace MCP *Developer Preview* (<https://developers.google.com/workspace/guides/configure-mcp-servers>).
2. Enable the **Gmail API** / **Google Calendar API** and their MCP services (`gmailmcp.googleapis.com`, `calendarmcp.googleapis.com`).
3. *Google Auth Platform → Clients → Create client*: type **Web application**, tick **"Use this client for an AI-powered agent"**, and add the redirect URI
   `http://127.0.0.1:19876/mcp/oauth/callback`. Configure the consent screen (External + yourself as test user is fine).
4. In Jarvis: *Connectors → Gmail* → paste the **Client ID** and **Client secret** (scopes are pre-filled) → *Add* → *Sign in* and approve in the browser.

Prefer something simpler? Use **Google Workspace (community)**: create an OAuth client of type *Desktop app*, enable the APIs, paste ID + secret; the Google login opens on first use.

Secrets (API keys, client secrets) are stored in `%APPDATA%\Jarvis\settings.json` on your machine only.

## Computer use

On first use in a chat Jarvis asks permission once ("I need to see the screen and control mouse and keyboard — allow for this chat?"). While it controls the PC the screen edge glows and a badge shows; **Ctrl+Alt+K** stops everything instantly.

Tools the agent has (all prefixed `jarvis_`):

* **Accessibility (preferred)**: `list_apps`, `get_app_state`, `click`, `set_value`, `type_text`, `press_key`, `scroll`, `drag`, `perform_secondary_action` (Open Computer Use — works on background windows, no focus stealing).
* **Any app, pixel level**: `screen` (OCR + UIA map with stable item numbers), `click_text`, `act`, `ask_screen` (vision), `type` (real Unicode keystrokes: focus + click field + type + Enter), `keys` (chords/media keys), `scroll_at` (mouse wheel anywhere), `mouse` (click/double/right/middle/move/down/up/drag, ctrl/shift modifiers), `hold_key`, `sequence` (timed steps, e.g. hold **W** 500 ms → wait → **Enter**; `scan:true` for games).
* **Waiting**: `wait` (until the screen settles), `wait_for` (until text/window appears) — so it never spams retries while a page loads.
* **Apps & windows**: `open_app`, `open_url`, `focus_window`, `windows`, `highlight`, clipboard.

## Voice commands (routines) and memory

* *"Jarvis, create a command *Привет*: open Spotify and say good morning."* — stored as a routine (steps: say, open, run, keys, type, wait, agent). When you say the phrase it runs instantly, without the model. Re-saving a name edits it; delete by voice or on the **Commands** page.
* **Memory** page: durable facts Jarvis knows about you (editable, pinnable). They are injected every turn; routines are *not* stored as memory.

## Resource use

* ASR models live in a **child process** started when you begin speaking and stopped after 2 min idle.
* The XTTS engine unloads after N idle minutes (default 10); Jarvis uses Piper until it is ready.
* PowerShell helpers and the Open Computer Use server stop when unused; the main window is destroyed when closed to the tray.
* Typical idle: ~250 MB Jarvis itself, ~1 GB all processes (clone engine unloaded, window in tray).

## Troubleshooting

| Symptom | Try |
|---|---|
| Something is off | *Settings → About → Open logs / Copy diagnostics* (`%APPDATA%\Jarvis\logs\jarvis.log`). |
| Stuck on "Listening" / doesn't hear the wake word | Check the microphone in *Settings → Listening*; raise sensitivity; make sure the speech models are installed. |
| No voice / robotic voice | Fish key missing or out of credits → Jarvis falls back to Piper. Install Piper voices in *Models & storage*. |
| Typing goes to the wrong app | Jarvis focuses the app before sending keys; use `jarvis_type` with `app`. Games may need `scan:true`. |
| Russian on screen is read badly | Add the Russian language pack in Windows (OCR uses installed languages). |
| A connector says *Sign-in needed* | Press **Sign in** and finish in the browser; for Google check the redirect URI `http://127.0.0.1:19876/mcp/oauth/callback`. |
| Local connector *Failed* | It needs Node.js (`npx`) or uv (`uvx`) on PATH. |
| Cloned voice errors | Needs an NVIDIA GPU with ~5 GB free VRAM; Jarvis falls back to Piper. |

## Privacy & safety

* All speech recognition runs on your PC. No telemetry.
* Network traffic: your chosen model endpoint, one-time model downloads (GitHub / Hugging Face), connectors you enable, and — only with a Fish Audio voice — the sentences Jarvis speaks.
* Risky shell patterns always ask; computer control is consent-gated per chat; connector writes ask first; **Ctrl+Alt+K** is a global kill switch.
* Screenshots taken for vision are sent to the model you selected — pick a local/endpoint model if that matters.

## Development

```bash
npm run dev        # electron-vite dev server
npm run typecheck
npm test           # unit tests (tsx --test)
npm run build
npm run dist       # unsigned NSIS installer in release/
```

Layout: `src/main` (assistant orchestrator, opencode server manager, MCP tool server, computer-use layer, speech engine, TTS), `src/renderer` (React UI: assistant, commands, memory, settings, HUD, overlays), `src/shared` (types, connector catalogue), `resources/bridge.ps1` (Windows UIA/OCR/input bridge), `voice/` (optional clone tooling).

Debug helpers are environment-gated (`JARVIS_SHOTS`, `JARVIS_TEST_*`) in `src/main/index.ts`.

Contributions are welcome — issues and PRs about new connectors (add an entry in `src/shared/connectors.ts`), voices, and computer-use reliability are especially useful.

## Licence

MIT (this project). Third-party components and models keep their own licences — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Note XTTS-v2 is non-commercial, and film-character voices may be protected: use cloned voices for personal use only.
