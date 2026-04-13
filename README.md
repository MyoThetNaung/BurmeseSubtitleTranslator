# Burmese Subtitle Translator (offline)

Desktop app for translating `.srt` subtitles **English → Burmese** using **local Qwen GGUF** models and **llama.cpp** (`llama-server`). Pick **Performance** (smaller) or **Quality** (27B) in the app. No cloud APIs, no Ollama.

## Layout

| Path | Purpose |
|------|---------|
| `app/` | Electron + React (electron-vite) |
| `engine/` | `llama-server.exe` + optional GPU DLLs (you provide binaries) |
| `models/` | `qwen3_5_9b.gguf` (Performance), `Qwen3.5-27B-Q4_K_M.gguf` (Quality) |
| `utils/` | SRT parse/serialize, batching, prompts, output parsing |
| `LICENSES/` | Third-party notices |

## Prerequisites

- **Node.js 20+** and npm
- **Windows x64** for the packaged `.exe`
- **llama.cpp** Windows build with **`llama-server.exe`** in `engine/` (see `engine/README.txt`)
- **Qwen GGUF** files in `models/` (or `%APPDATA%\burmese-subtitle-translator\models`): **`qwen3_5_9b.gguf`** for Performance, **`Qwen3.5-27B-Q4_K_M.gguf`** for Quality. You can install one or both; the app checks the file for the selected tier. On **12 GB VRAM** (e.g. RTX 3060), the 27B model usually uses **partial GPU offload**; lower `SUBTITLE_LLM_NGL` if you hit OOM.

## Development

```powershell
cd app
npm install
npm run dev
```

## Production build (Windows installer)

```powershell
cd app
npm install
npm run build
npm run dist
```

Artifacts appear under `app/release/` (NSIS installer and unpacked `win-unpacked`).

If `electron-builder` fails while extracting signing tools (symlink permission errors), either enable **Developer Mode** on Windows or run the build from an environment where symlinks are allowed; the sample `package.json` sets `forceCodeSigning: false` and `signAndEditExecutable: false` to reduce signing-tool dependencies.

## GPU vs CPU

In the app toolbar, **Inference** selects:

- **GPU (`-ngl N`)** — GPU offload (default **N = 99**, or set via environment before first run).
- **CPU (no GPU offload)** — omits `-ngl` so inference stays on the CPU (slower; works without a GPU).

You can still tune the GPU layer count for **GPU** mode when launching (affects the default N):

```powershell
$env:SUBTITLE_LLM_NGL="35"
```

Use `SUBTITLE_LLM_NGL=0` only if you want the **default stored value** to start at CPU; the in-app **Inference** dropdown always overrides the saved setting.

## Licensing

This project does not redistribute model weights or llama.cpp binaries. Use third-party materials only under their respective licenses.
