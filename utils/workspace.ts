import type { OpenAiTier, SubtitleCue, SubtitleWorkspace } from './types'

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

  let selectedModel: SubtitleWorkspace['selectedModel'] = 'qwen9b'
  if (
    o.selectedModel === 'qwen9b' ||
    o.selectedModel === 'qwen27b' ||
    o.selectedModel === 'gemini' ||
    o.selectedModel === 'openai'
  ) {
    selectedModel = o.selectedModel
  }
  let inferenceMode: SubtitleWorkspace['inferenceMode'] = 'gpu'
  if (o.inferenceMode === 'cpu' || o.inferenceMode === 'gpu') {
    inferenceMode = o.inferenceMode
  }

  let openaiTier: OpenAiTier | undefined
  if (o.openaiTier === 'normal' || o.openaiTier === 'premium') {
    openaiTier = o.openaiTier
  }

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
    inferenceMode,
    ...(openaiTier !== undefined ? { openaiTier } : {}),
  }
}
