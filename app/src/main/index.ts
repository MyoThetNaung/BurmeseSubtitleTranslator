import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import Store from 'electron-store'
import type {
  SubtitleCue,
  ModelId,
  AppConfig,
  OpenAiTier,
  TranslationLanguage,
  TranslationMemoryEntry,
  TranslationPreset,
} from '@utils/types'
import { parseSrt, serializeSrt } from '@utils/index'
import { LlamaServerManager } from './llamaServer'
import {
  copyBundledModelsToUserData,
  modelExists,
  resolveDefaultModelsDir,
  shouldSuggestCopyModelsToAppData,
  userDataModelsDir,
} from './paths'
import { getSystemInfo } from './systemInfo'
import { runTranslateJob, runTranslateOneCue } from './translateService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const store = new Store<AppConfig & { nGpuLayers?: number }>({
  defaults: {
    selectedModel: 'qwen9b',
    modelsDir: undefined,
    openaiTier: 'normal' satisfies OpenAiTier,
    cloudTargetLanguage: 'myanmar' satisfies TranslationLanguage,
    nGpuLayers: (() => {
      const raw = process.env.SUBTITLE_LLM_NGL
      if (raw === undefined || raw === '') return 99
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) return 99
      return Math.min(999, n)
    })(),
  },
})

const llama = new LlamaServerManager()

let mainWindow: BrowserWindow | null = null

/** Env-tunable default for `-ngl` when GPU mode is selected (see README). */
function layersForGpuMode(): number {
  const raw = process.env.SUBTITLE_LLM_NGL
  if (raw === undefined || raw === '') return 99
  const n = Number(raw)
  if (!Number.isFinite(n)) return 99
  if (n <= 0) return 99
  return Math.min(999, n)
}

function defaultGpuLayers(): number {
  const v = store.get('nGpuLayers')
  if (typeof v === 'number' && v >= 0) return Math.min(999, v)
  return layersForGpuMode()
}

/** PNG next to packaged `out/main` (dev + production asar layout). */
function appIconPath(): string | undefined {
  const p = path.join(__dirname, '../../build/icon.png')
  return existsSync(p) ? p : undefined
}

function createWindow(): void {
  const icon = appIconPath()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

async function firstRunFlow(): Promise<void> {
  try {
    const suggest = await shouldSuggestCopyModelsToAppData()
    if (!suggest) return
    const dest = userDataModelsDir()
    let hasLocal = false
    try {
      const names = await fs.readdir(dest)
      hasLocal = names.some((f) => f.endsWith('.gguf'))
    } catch {
      hasLocal = false
    }
    if (hasLocal) return

    const res = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Copy now', 'Skip'],
      defaultId: 0,
      cancelId: 1,
      title: 'Copy models',
      message:
        'It looks like you are running from removable media. Copy GGUF models to your local profile for faster loading and disk access?',
    })
    if (res.response === 0) {
      const dir = await copyBundledModelsToUserData()
      store.set('modelsDir', dir)
    }
  } catch {
    /* non-fatal */
  }
}

function registerIpc(): void {
  const cleanTranslationMemory = (memory: TranslationMemoryEntry[]): TranslationMemoryEntry[] => {
    return memory
      .map((entry) => ({
        source: typeof entry?.source === 'string' ? entry.source.trim() : '',
        target: typeof entry?.target === 'string' ? entry.target.trim() : '',
      }))
      .filter((entry) => entry.source.length > 0 && entry.target.length > 0)
      .slice(0, 500)
  }

  const ensurePresetId = (raw: string): string => {
    const safe = raw.trim().replace(/[^a-z0-9_-]+/gi, '-')
    return safe.length > 0 ? safe.slice(0, 60) : `preset-${Date.now()}`
  }

  const readTranslationPresets = (): TranslationPreset[] => {
    const raw = store.get('translationPresets')
    if (!Array.isArray(raw) || raw.length === 0) {
      const legacyMemory = Array.isArray(store.get('translationMemory'))
        ? cleanTranslationMemory(store.get('translationMemory') as TranslationMemoryEntry[])
        : []
      return [{ id: 'default', name: 'Default', memory: legacyMemory }]
    }
    const byId = new Map<string, TranslationPreset>()
    for (const entry of raw as TranslationPreset[]) {
      const id = ensurePresetId(typeof entry?.id === 'string' ? entry.id : '')
      const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
      if (!id || !name) continue
      byId.set(id, {
        id,
        name: name.slice(0, 60),
        memory: cleanTranslationMemory(Array.isArray(entry.memory) ? entry.memory : []),
      })
    }
    const presets = [...byId.values()]
    if (presets.length > 0) return presets
    return [{ id: 'default', name: 'Default', memory: [] }]
  }

  const activePresetId = (presets: TranslationPreset[]): string => {
    const raw = store.get('activeTranslationPresetId')
    if (typeof raw === 'string' && presets.some((preset) => preset.id === raw)) {
      return raw
    }
    return presets[0]?.id ?? 'default'
  }

  const readTranslationMemory = (): TranslationMemoryEntry[] => {
    const presets = readTranslationPresets()
    const activeId = activePresetId(presets)
    return presets.find((preset) => preset.id === activeId)?.memory ?? []
  }

  const writePresetsAndActive = (presets: TranslationPreset[], activeId: string): void => {
    const safePresets = presets.length ? presets : [{ id: 'default', name: 'Default', memory: [] }]
    const safeActive = safePresets.some((preset) => preset.id === activeId)
      ? activeId
      : safePresets[0].id
    store.set('translationPresets', safePresets)
    store.set('activeTranslationPresetId', safeActive)
    const activeMemory = safePresets.find((preset) => preset.id === safeActive)?.memory ?? []
    store.set('translationMemory', activeMemory)
  }

  const mergeTranslationMemory = (
    base: TranslationMemoryEntry[],
    extra: TranslationMemoryEntry[],
  ): TranslationMemoryEntry[] => {
    const bySource = new Map<string, TranslationMemoryEntry>()
    for (const entry of base) {
      bySource.set(entry.source.toLowerCase(), entry)
    }
    for (const entry of extra) {
      const source = entry.source.trim()
      const target = entry.target.trim()
      if (!source || !target) continue
      bySource.set(source.toLowerCase(), { source, target })
    }
    return [...bySource.values()].slice(0, 500)
  }

  ipcMain.handle('config:get', async () => {
    const modelsDir = resolveDefaultModelsDir(store.get('modelsDir'))
    const raw = store.get('selectedModel')
    const safeModel: ModelId =
      raw === 'qwen9b' || raw === 'qwen27b' || raw === 'gemini' || raw === 'openai' ? raw : 'qwen9b'
    if (raw !== safeModel) {
      store.set('selectedModel', safeModel)
    }
    const n = defaultGpuLayers()
    const geminiKey = store.get('geminiApiKey')
    const openaiKey = store.get('openaiApiKey')
    const openaiTier: OpenAiTier = store.get('openaiTier') === 'premium' ? 'premium' : 'normal'
    const cloudTargetLanguage: TranslationLanguage =
      store.get('cloudTargetLanguage') === 'thai' ? 'thai' : 'myanmar'
    const translationPresets = readTranslationPresets()
    const activeTranslationPresetId = activePresetId(translationPresets)
    const translationMemory =
      translationPresets.find((preset) => preset.id === activeTranslationPresetId)?.memory ?? []
    writePresetsAndActive(translationPresets, activeTranslationPresetId)
    return {
      selectedModel: safeModel,
      modelsDir: store.get('modelsDir') ?? null,
      resolvedModelsDir: modelsDir,
      nGpuLayers: n,
      inferenceMode: n === 0 ? ('cpu' as const) : ('gpu' as const),
      gpuLayersForGpuMode: layersForGpuMode(),
      geminiApiKeyConfigured: typeof geminiKey === 'string' && geminiKey.trim().length > 0,
      openaiApiKeyConfigured: typeof openaiKey === 'string' && openaiKey.trim().length > 0,
      openaiTier,
      cloudTargetLanguage,
      translationMemory,
      translationPresets,
      activeTranslationPresetId,
    }
  })

  ipcMain.handle(
    'config:set',
    async (
      _e,
      partial: Partial<AppConfig & { nGpuLayers?: number; inferenceMode?: 'cpu' | 'gpu' }>,
    ) => {
      if (
        partial.selectedModel === 'qwen9b' ||
        partial.selectedModel === 'qwen27b' ||
        partial.selectedModel === 'gemini' ||
        partial.selectedModel === 'openai'
      ) {
        store.set('selectedModel', partial.selectedModel)
      }
      if (partial.geminiApiKey !== undefined) {
        store.set('geminiApiKey', partial.geminiApiKey)
      }
      if (partial.openaiApiKey !== undefined) {
        store.set('openaiApiKey', partial.openaiApiKey)
      }
      if (partial.openaiTier === 'normal' || partial.openaiTier === 'premium') {
        store.set('openaiTier', partial.openaiTier)
      }
      if (partial.cloudTargetLanguage === 'myanmar' || partial.cloudTargetLanguage === 'thai') {
        store.set('cloudTargetLanguage', partial.cloudTargetLanguage)
      }
      if (Array.isArray(partial.translationMemory)) {
        const presets = readTranslationPresets()
        const activeId = activePresetId(presets)
        const cleaned = cleanTranslationMemory(partial.translationMemory as TranslationMemoryEntry[])
        writePresetsAndActive(
          presets.map((preset) => (preset.id === activeId ? { ...preset, memory: cleaned } : preset)),
          activeId,
        )
      }
      if (Array.isArray((partial as AppConfig).translationPresets)) {
        const incoming = (partial as AppConfig).translationPresets as TranslationPreset[]
        const byId = new Map<string, TranslationPreset>()
        for (const preset of incoming) {
          const id = ensurePresetId(typeof preset?.id === 'string' ? preset.id : '')
          const name = typeof preset?.name === 'string' ? preset.name.trim() : ''
          if (!id || !name) continue
          byId.set(id, {
            id,
            name: name.slice(0, 60),
            memory: cleanTranslationMemory(Array.isArray(preset.memory) ? preset.memory : []),
          })
        }
        const presets = [...byId.values()]
        const requestedActiveId =
          typeof (partial as AppConfig).activeTranslationPresetId === 'string'
            ? ensurePresetId((partial as AppConfig).activeTranslationPresetId ?? '')
            : activePresetId(presets)
        writePresetsAndActive(presets, requestedActiveId)
      } else if (typeof (partial as AppConfig).activeTranslationPresetId === 'string') {
        const presets = readTranslationPresets()
        writePresetsAndActive(presets, ensurePresetId((partial as AppConfig).activeTranslationPresetId ?? ''))
      }
      if (partial.modelsDir !== undefined) store.set('modelsDir', partial.modelsDir)
      if (typeof partial.nGpuLayers === 'number' && partial.nGpuLayers >= 0) {
        store.set('nGpuLayers', partial.nGpuLayers)
      } else if (partial.inferenceMode === 'cpu') {
        store.set('nGpuLayers', 0)
      } else if (partial.inferenceMode === 'gpu') {
        store.set('nGpuLayers', layersForGpuMode())
      }
    },
  )

  ipcMain.handle('models:copyToAppData', async () => {
    const dir = await copyBundledModelsToUserData()
    store.set('modelsDir', dir)
    return dir
  })

  ipcMain.handle('models:status', async () => {
    const dir = resolveDefaultModelsDir(store.get('modelsDir'))
    return {
      dir,
      qwen9b: modelExists('qwen9b', dir),
      qwen27b: modelExists('qwen27b', dir),
    }
  })

  ipcMain.handle('system:info', async () => {
    const info = await getSystemInfo()
    return { ...info }
  })

  ipcMain.handle('subtitle:parse', async (_e, raw: string) => {
    return parseSrt(raw)
  })

  ipcMain.handle('subtitle:serialize', async (_e, cues: SubtitleCue[]) => {
    return serializeSrt(cues)
  })

  ipcMain.handle('dialog:openSrt', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Open subtitle file',
      filters: [{ name: 'SubRip', extensions: ['srt'] }],
      properties: ['openFile'],
    })
    if (r.canceled || !r.filePaths[0]) return null
    const filePath = r.filePaths[0]
    const text = await fs.readFile(filePath, 'utf-8')
    return { filePath, text }
  })

  ipcMain.handle('dialog:saveSrt', async (_e, defaultName: string) => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showSaveDialog(win ?? undefined, {
      title: 'Export translated subtitles',
      defaultPath: defaultName || 'translated.srt',
      filters: [{ name: 'SubRip', extensions: ['srt'] }],
    })
    if (r.canceled || !r.filePath) return null
    return r.filePath
  })

  ipcMain.handle('dialog:saveWorkspace', async (_e, defaultName: string) => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showSaveDialog(win ?? undefined, {
      title: 'Save workspace',
      defaultPath: defaultName || 'subtitle-workspace.bsw',
      filters: [{ name: 'Workspace', extensions: ['bsw'] }],
    })
    if (r.canceled || !r.filePath) return null
    return r.filePath
  })

  ipcMain.handle('dialog:openWorkspace', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Open saved workspace',
      filters: [
        { name: 'Workspace', extensions: ['bsw', 'json'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (r.canceled || !r.filePaths[0]) return null
    const filePath = r.filePaths[0]
    const text = await fs.readFile(filePath, 'utf-8')
    return { filePath, text }
  })

  ipcMain.handle('fs:readUtf8', async (_e, filePath: string) => {
    return fs.readFile(filePath, 'utf-8')
  })

  ipcMain.handle('fs:writeUtf8', async (_e, filePath: string, data: string) => {
    await fs.writeFile(filePath, data, 'utf-8')
    return true
  })

  ipcMain.handle(
    'translate:start',
    async (
      event,
      payload: {
        cues: SubtitleCue[]
        modelKey: ModelId
        targetLanguage?: TranslationLanguage
        translationMemory?: TranslationMemoryEntry[]
      },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window')

      const modelsDir = resolveDefaultModelsDir(store.get('modelsDir'))
      const modelKey =
        payload.modelKey === 'qwen9b' ||
        payload.modelKey === 'qwen27b' ||
        payload.modelKey === 'gemini' ||
        payload.modelKey === 'openai'
          ? payload.modelKey
          : 'qwen9b'
      store.set('selectedModel', modelKey)

      const tierRaw = store.get('openaiTier')
      const openaiTier: OpenAiTier = tierRaw === 'premium' ? 'premium' : 'normal'

      const targetLanguage: TranslationLanguage =
        payload.targetLanguage === 'thai' || payload.targetLanguage === 'myanmar'
          ? payload.targetLanguage
          : store.get('cloudTargetLanguage') === 'thai'
            ? 'thai'
            : 'myanmar'
      store.set('cloudTargetLanguage', targetLanguage)
      if (Array.isArray(payload.translationMemory)) {
        const presets = readTranslationPresets()
        const activeId = activePresetId(presets)
        const cleanedPayloadMemory = cleanTranslationMemory(payload.translationMemory)
        writePresetsAndActive(
          presets.map((preset) =>
            preset.id === activeId ? { ...preset, memory: cleanedPayloadMemory } : preset,
          ),
          activeId,
        )
      }
      const translationMemory = readTranslationMemory()

      const result = await runTranslateJob(win, llama, {
        cues: payload.cues,
        modelKey,
        modelsDir,
        nGpuLayers: defaultGpuLayers(),
        geminiApiKey: store.get('geminiApiKey'),
        openaiApiKey: store.get('openaiApiKey'),
        openaiTier,
        targetLanguage,
        translationMemory,
      })
      const learnedPairs: TranslationMemoryEntry[] = result
        .map((cue, i) => ({
          source: payload.cues[i]?.text?.trim() ?? '',
          target: cue.text.trim(),
        }))
        .filter((entry) => entry.source.length > 0 && entry.target.length > 0)
      const mergedMemory = mergeTranslationMemory(translationMemory, learnedPairs)
      const presets = readTranslationPresets()
      const activeId = activePresetId(presets)
      writePresetsAndActive(
        presets.map((preset) => (preset.id === activeId ? { ...preset, memory: mergedMemory } : preset)),
        activeId,
      )
      return result
    },
  )

  ipcMain.handle('translate:cancel', () => {
    llama.cancelInference()
    return true
  })

  ipcMain.handle(
    'translate:one',
    async (
      event,
      payload: {
        cue: SubtitleCue
        modelKey: ModelId
        targetLanguage?: TranslationLanguage
        translationMemory?: TranslationMemoryEntry[]
      },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window')

      const modelsDir = resolveDefaultModelsDir(store.get('modelsDir'))
      const modelKey =
        payload.modelKey === 'qwen9b' ||
        payload.modelKey === 'qwen27b' ||
        payload.modelKey === 'gemini' ||
        payload.modelKey === 'openai'
          ? payload.modelKey
          : 'qwen9b'
      store.set('selectedModel', modelKey)

      const tierRaw = store.get('openaiTier')
      const openaiTier: OpenAiTier = tierRaw === 'premium' ? 'premium' : 'normal'

      const targetLanguage: TranslationLanguage =
        payload.targetLanguage === 'thai' || payload.targetLanguage === 'myanmar'
          ? payload.targetLanguage
          : store.get('cloudTargetLanguage') === 'thai'
            ? 'thai'
            : 'myanmar'
      store.set('cloudTargetLanguage', targetLanguage)
      if (Array.isArray(payload.translationMemory)) {
        const presets = readTranslationPresets()
        const activeId = activePresetId(presets)
        const cleanedPayloadMemory = cleanTranslationMemory(payload.translationMemory)
        writePresetsAndActive(
          presets.map((preset) =>
            preset.id === activeId ? { ...preset, memory: cleanedPayloadMemory } : preset,
          ),
          activeId,
        )
      }
      const translationMemory = readTranslationMemory()

      const result = await runTranslateOneCue(win, llama, {
        cue: payload.cue,
        modelKey,
        modelsDir,
        nGpuLayers: defaultGpuLayers(),
        geminiApiKey: store.get('geminiApiKey'),
        openaiApiKey: store.get('openaiApiKey'),
        openaiTier,
        targetLanguage,
        translationMemory,
      })
      if (payload.cue.text.trim() && result.trim()) {
        const merged = mergeTranslationMemory(translationMemory, [
          { source: payload.cue.text.trim(), target: result.trim() },
        ])
        const presets = readTranslationPresets()
        const activeId = activePresetId(presets)
        writePresetsAndActive(
          presets.map((preset) => (preset.id === activeId ? { ...preset, memory: merged } : preset)),
          activeId,
        )
      }
      return result
    },
  )
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()
  await firstRunFlow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void llama.stop().finally(() => app.quit())
  }
})

app.on('before-quit', () => {
  void llama.stop()
})
