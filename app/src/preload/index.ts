import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  SubtitleCue,
  ModelId,
  RendererConfig,
  AppConfig,
  TranslationLanguage,
  TranslationMemoryEntry,
} from '@utils/types'

const api = {
  pathForFile: (file: File) => webUtils.getPathForFile(file),

  getConfig: (): Promise<RendererConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (partial: Partial<AppConfig & { nGpuLayers?: number; inferenceMode?: 'cpu' | 'gpu' }>) =>
    ipcRenderer.invoke('config:set', partial),

  copyModelsToAppData: () => ipcRenderer.invoke('models:copyToAppData'),
  getModelsStatus: () => ipcRenderer.invoke('models:status'),

  getSystemInfo: () => ipcRenderer.invoke('system:info'),

  parseSubtitle: (raw: string) => ipcRenderer.invoke('subtitle:parse', raw),
  serializeSubtitle: (cues: SubtitleCue[]) => ipcRenderer.invoke('subtitle:serialize', cues),

  openSrtDialog: () => ipcRenderer.invoke('dialog:openSrt'),
  saveSrtDialog: (defaultName: string) => ipcRenderer.invoke('dialog:saveSrt', defaultName),
  saveWorkspaceDialog: (defaultName: string) =>
    ipcRenderer.invoke('dialog:saveWorkspace', defaultName),
  openWorkspaceDialog: () => ipcRenderer.invoke('dialog:openWorkspace'),
  readUtf8File: (filePath: string) => ipcRenderer.invoke('fs:readUtf8', filePath),
  writeUtf8File: (filePath: string, data: string) => ipcRenderer.invoke('fs:writeUtf8', filePath, data),

  translate: (payload: {
    cues: SubtitleCue[]
    modelKey: ModelId
    localModelFile?: string
    geminiModelId?: string
    openaiModelId?: string
    targetLanguage?: TranslationLanguage
    translationMemory?: TranslationMemoryEntry[]
  }) =>
    ipcRenderer.invoke('translate:start', payload),

  translateOne: (payload: {
    cue: SubtitleCue
    modelKey: ModelId
    localModelFile?: string
    geminiModelId?: string
    openaiModelId?: string
    targetLanguage?: TranslationLanguage
    translationMemory?: TranslationMemoryEntry[]
  }) =>
    ipcRenderer.invoke('translate:one', payload),

  cancelTranslate: () => ipcRenderer.invoke('translate:cancel'),

  onTranslateProgress: (cb: (data: Record<string, unknown>) => void) => {
    const handler = (_: unknown, data: Record<string, unknown>) => cb(data)
    ipcRenderer.on('translate:progress', handler)
    return () => ipcRenderer.removeListener('translate:progress', handler)
  },

  onTranslateStream: (cb: (data: Record<string, unknown>) => void) => {
    const handler = (_: unknown, data: Record<string, unknown>) => cb(data)
    ipcRenderer.on('translate:stream', handler)
    return () => ipcRenderer.removeListener('translate:stream', handler)
  },
}

contextBridge.exposeInMainWorld('subtitleApp', api)

export type SubtitleAppApi = typeof api
