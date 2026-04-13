/**
 * Shared types for subtitle parsing and translation pipelines.
 */

export interface SubtitleCue {
  index: number
  startMs: number
  endMs: number
  text: string
}

export type ModelId = 'qwen9b' | 'qwen27b' | 'gemini' | 'openai'

/** OpenAI cloud tier: normal (GPT-5 mini) vs premium (GPT-5). */
export type OpenAiTier = 'normal' | 'premium'

export interface AppConfig {
  selectedModel: ModelId
  modelsDir?: string
  /** Google AI (Gemini) API key; persisted by the Electron main process only. */
  geminiApiKey?: string
  /** OpenAI API key; persisted by the Electron main process only. */
  openaiApiKey?: string
  /** When `selectedModel` is `openai`, selects cost vs quality tier. */
  openaiTier?: OpenAiTier
}

/** Safe subset from `config:get` (no plaintext API keys). */
export interface RendererConfig {
  selectedModel: ModelId
  modelsDir: string | null
  resolvedModelsDir: string
  nGpuLayers: number
  inferenceMode: 'cpu' | 'gpu'
  gpuLayersForGpuMode: number
  geminiApiKeyConfigured: boolean
  openaiApiKeyConfigured: boolean
  openaiTier: OpenAiTier
}

/** Saved session for continuing translation/editing later (.bsw JSON). */
export interface SubtitleWorkspace {
  version: 1
  savedAt: string
  /** Path shown when the .srt was opened (may be missing if only workspace was used). */
  sourceFileLabel: string
  cues: SubtitleCue[]
  translated: SubtitleCue[] | null
  findText: string
  replaceText: string
  replaceScope: 'original' | 'translated' | 'both'
  replaceIgnoreCase: boolean
  selectedModel: ModelId
  inferenceMode: 'gpu' | 'cpu'
  /** Remembered when using Cloud (OpenAI); optional for older workspace files. */
  openaiTier?: OpenAiTier
}
