import type {
  OpenAiTier,
  SubtitleCue,
  SubtitleWorkspace,
  TranslationLanguage,
  TranslationMemoryEntry,
  TranslationPreset,
} from './types'

function isCue(x: unknown): x is SubtitleCue {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.index === 'number' &&
    Number.isFinite(o.index) &&
    typeof o.startMs === 'number' &&
    Number.isFinite(o.startMs) &&
    typeof o.endMs === 'number' &&
    Number.isFinite(o.endMs) &&
    typeof o.text === 'string'
  )
}

function isTranslationMemoryEntry(x: unknown): x is TranslationMemoryEntry {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.source === 'string' && typeof o.target === 'string'
}

function isTranslationPreset(x: unknown): x is TranslationPreset {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    Array.isArray(o.memory) &&
    o.memory.every(isTranslationMemoryEntry)
  )
}

/**
 * Parse and validate workspace JSON from disk.
 */
export function parseWorkspaceJson(text: string): SubtitleWorkspace {
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    throw new Error('Workspace file is not valid JSON.')
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid workspace file.')
  }
  const o = raw as Record<string, unknown>
  if (o.version !== 1) {
    throw new Error(`Unsupported workspace version: ${String(o.version)}`)
  }
  if (!Array.isArray(o.cues) || !o.cues.every(isCue)) {
    throw new Error('Invalid or missing subtitle cues in workspace.')
  }
  const cues = o.cues as SubtitleCue[]
  if (o.translated !== null && o.translated !== undefined) {
    if (!Array.isArray(o.translated) || !o.translated.every(isCue)) {
      throw new Error('Invalid translated cues in workspace.')
    }
    if ((o.translated as SubtitleCue[]).length !== cues.length) {
      throw new Error('Translated cues must match the number of original cues.')
    }
  }
  const translated =
    o.translated === null || o.translated === undefined ? null : (o.translated as SubtitleCue[])

  const findText = typeof o.findText === 'string' ? o.findText : ''
  const replaceText = typeof o.replaceText === 'string' ? o.replaceText : ''
  const replaceIgnoreCase = typeof o.replaceIgnoreCase === 'boolean' ? o.replaceIgnoreCase : false
  let replaceScope: SubtitleWorkspace['replaceScope'] = 'both'
  if (o.replaceScope === 'original' || o.replaceScope === 'translated' || o.replaceScope === 'both') {
    replaceScope = o.replaceScope
  }

  let selectedModel: SubtitleWorkspace['selectedModel'] = 'local'
  if (
    o.selectedModel === 'local' ||
    o.selectedModel === 'qwen9b' ||
    o.selectedModel === 'qwen27b' ||
    o.selectedModel === 'gemini' ||
    o.selectedModel === 'openai'
  ) {
    selectedModel = o.selectedModel
  }
  const localModelFile =
    typeof o.localModelFile === 'string' && o.localModelFile.trim().length > 0
      ? o.localModelFile.trim()
      : undefined
  let inferenceMode: SubtitleWorkspace['inferenceMode'] = 'gpu'
  if (o.inferenceMode === 'cpu' || o.inferenceMode === 'gpu') {
    inferenceMode = o.inferenceMode
  }

  let openaiTier: OpenAiTier | undefined
  if (o.openaiTier === 'normal' || o.openaiTier === 'premium') {
    openaiTier = o.openaiTier
  }
  const cloudProvider =
    o.cloudProvider === 'gemini' || o.cloudProvider === 'openai' ? o.cloudProvider : undefined
  const geminiModelId =
    typeof o.geminiModelId === 'string' && o.geminiModelId.trim().length > 0
      ? o.geminiModelId.trim()
      : undefined
  const openaiModelId =
    typeof o.openaiModelId === 'string' && o.openaiModelId.trim().length > 0
      ? o.openaiModelId.trim()
      : undefined
  let cloudTargetLanguage: TranslationLanguage | undefined
  if (o.cloudTargetLanguage === 'myanmar' || o.cloudTargetLanguage === 'thai') {
    cloudTargetLanguage = o.cloudTargetLanguage
  }
  let translationMemory: TranslationMemoryEntry[] | undefined
  if (Array.isArray(o.translationMemory) && o.translationMemory.every(isTranslationMemoryEntry)) {
    translationMemory = o.translationMemory
      .map((entry) => ({
        source: entry.source.trim(),
        target: entry.target.trim(),
      }))
      .filter((entry) => entry.source.length > 0 && entry.target.length > 0)
  }
  let translationPresets: TranslationPreset[] | undefined
  if (Array.isArray(o.translationPresets) && o.translationPresets.every(isTranslationPreset)) {
    translationPresets = o.translationPresets
      .map((preset) => ({
        id: preset.id.trim(),
        name: preset.name.trim(),
        memory: preset.memory
          .map((entry) => ({
            source: entry.source.trim(),
            target: entry.target.trim(),
          }))
          .filter((entry) => entry.source.length > 0 && entry.target.length > 0)
          .slice(0, 500),
      }))
      .filter((preset) => preset.id.length > 0 && preset.name.length > 0)
  }
  const activeTranslationPresetId =
    typeof o.activeTranslationPresetId === 'string' && o.activeTranslationPresetId.trim().length > 0
      ? o.activeTranslationPresetId.trim()
      : undefined

  const savedAt = typeof o.savedAt === 'string' ? o.savedAt : new Date().toISOString()
  const sourceFileLabel = typeof o.sourceFileLabel === 'string' ? o.sourceFileLabel : ''

  return {
    version: 1,
    savedAt,
    sourceFileLabel,
    cues,
    translated,
    findText,
    replaceText,
    replaceScope,
    replaceIgnoreCase,
    selectedModel,
    ...(localModelFile !== undefined ? { localModelFile } : {}),
    inferenceMode,
    ...(openaiTier !== undefined ? { openaiTier } : {}),
    ...(cloudProvider !== undefined ? { cloudProvider } : {}),
    ...(geminiModelId !== undefined ? { geminiModelId } : {}),
    ...(openaiModelId !== undefined ? { openaiModelId } : {}),
    ...(cloudTargetLanguage !== undefined ? { cloudTargetLanguage } : {}),
    ...(translationMemory !== undefined ? { translationMemory } : {}),
    ...(translationPresets !== undefined ? { translationPresets } : {}),
    ...(activeTranslationPresetId !== undefined ? { activeTranslationPresetId } : {}),
  }
}
