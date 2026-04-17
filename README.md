# Burmese Subtitle Translator

Desktop app for translating `.srt` subtitles (English -> Myanmar or Thai) with:

- **Local GGUF models** via `llama.cpp` (`llama-server`)
- **Cloud models** via **Google AI (Gemini)** or **OpenAI**

No Ollama is required.

## Project Layout

| Path | Purpose |
|------|---------|
| `app/` | Electron + React app (`electron-vite`) |
| `engine/` | `llama-server.exe` and optional GPU runtime DLLs |
| `models/` | Local `.gguf` files for offline/local inference |
| `utils/` | shared types, prompts, batch helpers, SRT parse/serialize |
| `LICENSES/` | third-party notices |

## How The App Works

### 1) Translation mode flow

In the app menu:

1. Choose **Mode**:
   - `Local`
   - `Cloud`
2. If `Local`: choose one detected `.gguf` file from your `models` folder.
3. If `Cloud`:
   - choose provider: `Google AI` or `OpenAI`
   - choose specific model from available list
   - save API key for that provider

### 2) Translation execution flow

- Subtitles are grouped into batches (default 7 cues per batch, 3 in fast test mode).
- For each batch, the app builds a strict translation prompt with optional memory hints.
- The app streams partial output to UI while translating.
- Output is parsed and validated; suspicious output triggers stricter retry logic.
- For multiline cues, fallback logic preserves line count and can translate line-by-line if needed.

### 3) Memory flow

The app uses two visible memory sources:

- **Train Data** (manual glossary/training)
- **Memory Data** (saved memory entries, including export-learned entries)

Effective memory = merged default + optional sequel preset memory.

Note: translation no longer auto-inserts hidden memory entries on each run.

## Prerequisites

- **Node.js 20+** and npm
- **Windows x64** (for packaged app target)
- For Local mode:
  - `llama-server.exe` available in `engine/`
  - one or more `.gguf` models in `models/` (or copied to app data cache)
- For Cloud mode:
  - valid API key for Google AI and/or OpenAI

## Development

```powershell
cd app
npm install
npm run dev
```

## Build (Windows installer)

```powershell
cd app
npm install
npm run build
npm run dist
```

Build artifacts are written to `app/release/`.

## Runtime Notes

- **Local inference mode**
  - GPU: uses `-ngl N` offload (`N` default is 99)
  - CPU: disables GPU offload
- Tune local GPU offload default with:

```powershell
$env:SUBTITLE_LLM_NGL="35"
```

- Cloud model speed depends on network/provider load.
- Gemini high-demand errors (`503`) are retried with backoff in app.

## Configuration Environment Variables

- `SUBTITLE_LLM_NGL`: default local GPU layer count
- `SUBTITLE_FAST_TEST=1`: smaller batch size (faster iteration, lower throughput)
- `SUBTITLE_GEMINI_MODEL`: fallback Gemini model if UI/model config is not set
- `SUBTITLE_OPENAI_MODEL_NORMAL`: fallback OpenAI model for normal tier
- `SUBTITLE_OPENAI_MODEL_PREMIUM`: fallback OpenAI model for premium tier

## Licensing

This repository does not ship proprietary model weights or `llama.cpp` binaries.
Use all third-party binaries/models under their respective licenses.