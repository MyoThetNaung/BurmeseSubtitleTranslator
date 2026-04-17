/**
 * Orchestrates batched subtitle translation via llama.cpp and reports progress to the UI.
 */

import type {
  OpenAiTier,
  SubtitleCue,
  ModelId,
  TranslationLanguage,
  TranslationMemoryEntry,
} from '@utils/types'
import { buildBatches } from '@utils/batchSubtitles'
import { resourcesEngineDir, MODEL_FILES } from './paths'
import { runGeminiTranslateJob, runGeminiTranslateOneCue } from './geminiTranslate'
import { runOpenAiTranslateJob, runOpenAiTranslateOneCue } from './openaiTranslate'
import { LlamaServerManager, TranslationCancelled } from './llamaServer'
import type { BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import path from 'path'

export interface TranslateJobOptions {
  cues: SubtitleCue[]
  modelKey: ModelId
  localModelFile?: string
  modelsDir: string
  nGpuLayers: number
  /** Required when modelKey is `gemini`. */
  geminiApiKey?: string
  geminiModelId?: string
  /** Required when modelKey is `openai`. */
  openaiApiKey?: string
  openaiModelId?: string
  openaiTier?: OpenAiTier
  targetLanguage?: TranslationLanguage
  translationMemory?: TranslationMemoryEntry[]
  linesPerBatch?: number
}

function normalizeForCompare(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasMyanmarChars(input: string): boolean {
  return /[\u1000-\u109f]/.test(input)
}

function looksUntranslated(source: string, translated: string): boolean {
  const out = translated.trim()
  if (!out) return true
  if (hasMyanmarChars(out)) return false
  return normalizeForCompare(source) === normalizeForCompare(out)
}

/**
 * Some local models echo glossary/training entries (e.g. `"foo" => "bar"`) instead of translating
 * the current subtitle line. Treat these as invalid candidate outputs.
 */
function looksLikeGlossaryEcho(translated: string): boolean {
  const out = translated.trim()
  if (!out) return false
  return (
    /=>|->/.test(out) ||
    /^[*-]\s*["'`].+["'`]\s*(=>|->|:)\s*["'`].+["'`]\s*$/i.test(out) ||
    /^["'`].+["'`]\s*(=>|->|:)\s*["'`].+["'`]\s*$/i.test(out)
  )
}

/**
 * Detect pathological repetition loops from local models, e.g. the same syllable/word repeated
 * many times. These are malformed outputs and should trigger retry/fallback.
 */
function looksLikeRepetitionSpam(translated: string): boolean {
  const out = translated.trim()
  if (!out) return false
  const tokens = out.split(/\s+/).filter(Boolean)
  if (tokens.length >= 8) {
    const unique = new Set(tokens.map((t) => t.toLowerCase())).size
    if (unique <= 2 && tokens.length / Math.max(1, unique) >= 4) return true
  }
  if (/([\u1000-\u109f]{1,4})(?:\s*\1){5,}/u.test(out)) return true
  if (/([A-Za-z]{1,6})(?:\s+\1){5,}/.test(out)) return true
  return false
}

/** Qwen3 / reasoning models often emit section headers before the real answer. */
function isReasoningOrMetaLine(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (hasMyanmarChars(t)) return false
  if (/^thinking\b[:\s]*/i.test(t)) return true
  if (/analyze the request/i.test(t)) return true
  if (/^\*\*[^*]+\*\*\s*$/.test(t)) return true
  if (/^(#{1,6}\s|[-*]{3,}\s*$)/.test(t)) return true
  return false
}

function stripLeadingNumberPrefix(line: string): string {
  return line.replace(/^\s*(\d+)\s*[\.\)]\s*/, '').trim()
}

function splitCueLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Qwen3.5 “thinking” / reasoning output often puts **Analyze…** or headings first;
 * the Burmese line is usually after that or is the only line with Myanmar script.
 */
function cleanSingleLineOutput(source: string, raw: string): string {
  const normalized = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/`[\s\S]*?`/gi, ' ')
    .replace(/<redacted_thinking>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<\/?think>/gi, ' ')
    .trim()
  if (!normalized) return ''

  const sourceLines = splitCueLines(source)
  const expectedLineCount = Math.max(1, sourceLines.length)

  const lines = normalized
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const substantive = lines.filter((l) => !isReasoningOrMetaLine(l))
  const cleanedSubstantive = substantive
    .map((line) => stripLeadingNumberPrefix(line))
    .filter((line) => line.length > 0)

  if (expectedLineCount <= 1) {
    const myanmarLine = cleanedSubstantive.find((l) => hasMyanmarChars(l))
    const pick =
      myanmarLine ??
      (cleanedSubstantive.length > 0 ? cleanedSubstantive[cleanedSubstantive.length - 1] : undefined) ??
      lines.filter((l) => !isReasoningOrMetaLine(l)).at(-1) ??
      lines.at(-1) ??
      ''

    const cleaned = stripLeadingNumberPrefix(pick)
    if (/^<[^>]+>$/.test(cleaned)) return ''
    if (isReasoningOrMetaLine(cleaned) && !hasMyanmarChars(cleaned)) return ''
    return cleaned
  }

  const multiLineCandidates =
    cleanedSubstantive.length > 0
      ? cleanedSubstantive
      : lines.map((line) => stripLeadingNumberPrefix(line)).filter((line) => line.length > 0)
  const picked = multiLineCandidates.slice(0, expectedLineCount).join('\n').trim()
  return picked
}

function maxTokensForModel(modelKey: ModelId): number {
  // Larger “thinking” models need room after reasoning tokens for the actual line.
  if (modelKey === 'qwen27b') return 512
  return 160
}

function normalizeForKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function buildExactMemoryMap(memory: TranslationMemoryEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of memory) {
    const source = entry.source.trim()
    const target = entry.target.trim()
    if (!source || !target) continue
    map.set(normalizeForKey(source), target)
  }
  return map
}

function glossaryPromptSection(memory: TranslationMemoryEntry[]): string {
  const cleaned = memory
    .map((entry) => ({ source: entry.source.trim(), target: entry.target.trim() }))
    .filter((entry) => entry.source.length > 0 && entry.target.length > 0)
    .slice(0, 120)
  if (!cleaned.length) return ''
  return (
    'Terminology memory (must follow if source phrase appears):\n' +
    cleaned.map((entry) => `- "${entry.source}" => "${entry.target}"`).join('\n') +
    '\n'
  )
}

function applyTranslationMemory(
  source: string,
  translated: string,
  memory: TranslationMemoryEntry[],
): string {
  const exact = buildExactMemoryMap(memory).get(normalizeForKey(source))
  if (exact) return exact
  return translated
}

function buildLinePrompt(
  modelKey: ModelId,
  source: string,
  strict: boolean,
  memory: TranslationMemoryEntry[],
): string {
  const memorySection = glossaryPromptSection(memory)
  const antiReason =
    modelKey === 'qwen27b'
      ? 'Do not analyze or explain. No headings, no markdown. Myanmar script only; keep the same number of lines as the input.\n'
      : ''
  if (strict) {
    return (
      antiReason +
      'STRICT: Burmese only; translate names into Burmese script. Keep the same number of lines as the input. No analysis.\n' +
      memorySection +
      `English: ${source}\n` +
      'Burmese:'
    )
  }
  return (
    antiReason +
    'Translate the subtitle line to Burmese (Myanmar script), including names in Burmese script. Keep the same number of lines as the input. Output only Burmese text.\n' +
    memorySection +
    `English: ${source}\n` +
    'Burmese:'
  )
}

function buildBareStrictLinePrompt(source: string): string {
  return (
    'Translate this one English subtitle line to Burmese (Myanmar script).\n' +
    'Keep the same number of lines as the English input. No list. No quotes. No glossary format. No repeated words.\n' +
    `English: ${source}\n` +
    'Burmese:'
  )
}

async function translateMultilineCueByLine(
  llama: LlamaServerManager,
  modelKey: ModelId,
  source: string,
  memory: TranslationMemoryEntry[],
): Promise<string> {
  const sourceLines = splitCueLines(source)
  if (sourceLines.length <= 1) return ''
  const mt = maxTokensForModel(modelKey)
  const translatedLines: string[] = []
  for (const line of sourceLines) {
    const remembered = buildExactMemoryMap(memory).get(normalizeForKey(line))
    if (remembered) {
      translatedLines.push(remembered)
      continue
    }
    let full = ''
    const strictPrompt = buildLinePrompt(modelKey, line, true, memory)
    for await (const piece of llama.completionStream(strictPrompt, {
      maxTokens: mt,
      temperature: 0,
    })) {
      full += piece
    }
    let out = cleanSingleLineOutput(line, full)
    const bad =
      looksUntranslated(line, out) ||
      looksLikeGlossaryEcho(out) ||
      looksLikeRepetitionSpam(out) ||
      (modelKey === 'qwen27b' && out.length > 0 && !hasMyanmarChars(out))
    if (bad) {
      let bareStrictFull = ''
      const bareStrictPrompt = buildBareStrictLinePrompt(line)
      for await (const piece of llama.completionStream(bareStrictPrompt, {
        maxTokens: mt,
        temperature: 0,
      })) {
        bareStrictFull += piece
      }
      out = cleanSingleLineOutput(line, bareStrictFull)
    }
    translatedLines.push(out || line)
  }
  return translatedLines.join('\n').trim()
}

function cloneCuesWithTexts(cues: SubtitleCue[], texts: string[]): SubtitleCue[] {
  return cues.map((c, i) => ({
    ...c,
    text: texts[i] ?? c.text,
  }))
}

export async function runTranslateJob(
  win: BrowserWindow,
  llama: LlamaServerManager,
  opts: TranslateJobOptions,
): Promise<SubtitleCue[]> {
  const { cues, modelKey, modelsDir, nGpuLayers } = opts
  const translationMemory = opts.translationMemory ?? []
  const exactMemoryMap = buildExactMemoryMap(translationMemory)
  const fastMode = process.env.SUBTITLE_FAST_TEST === '1'
  const linesPerBatch = opts.linesPerBatch ?? (fastMode ? 3 : 7)

  llama.beginInference()

  if (modelKey === 'gemini') {
    const key = opts.geminiApiKey?.trim()
    if (!key) {
      throw new Error(
        'Gemini API key is not set. Open the menu, paste your key from Google AI Studio, and click Save key.',
      )
    }
    return runGeminiTranslateJob(win, llama, {
      cues,
      apiKey: key,
      modelId: opts.geminiModelId,
      targetLanguage: opts.targetLanguage ?? 'myanmar',
      translationMemory,
    })
  }

  if (modelKey === 'openai') {
    const key = opts.openaiApiKey?.trim()
    if (!key) {
      throw new Error(
        'OpenAI API key is not set. Open the menu → Cloud → OpenAI, paste your key, and click Save key.',
      )
    }
    const tier = opts.openaiTier ?? 'normal'
    return runOpenAiTranslateJob(win, llama, {
      cues,
      apiKey: key,
      modelId: opts.openaiModelId,
      tier,
      targetLanguage: opts.targetLanguage ?? 'myanmar',
      translationMemory,
    })
  }

  const localModelFile =
    modelKey === 'local'
      ? opts.localModelFile?.trim() ?? ''
      : modelKey === 'qwen27b'
        ? MODEL_FILES.qwen27b
        : MODEL_FILES.qwen9b
  if (!localModelFile) {
    throw new Error('Select a local model file first.')
  }
  const localModelPath = path.join(modelsDir, localModelFile)
  if (!existsSync(localModelPath)) {
    throw new Error(
      `Missing model file for local model. Place ${localModelFile} in your models folder.`,
    )
  }

  const modelPath = localModelPath
  const engineDir = resourcesEngineDir()
  await llama.ensureRunning({ engineDir, modelPath, nGpuLayers })

  const batches = buildBatches(cues, linesPerBatch)
  const translatedTexts: string[] = cues.map((c) => c.text)

  try {
    let doneBatches = 0
    for (const batch of batches) {
      for (let i = 0; i < batch.lines.length; i++) {
        const source = batch.lines[i] ?? ''
        const cueIdx = batch.cueIndices[i]
        const remembered = exactMemoryMap.get(normalizeForKey(source))
        if (remembered) {
          translatedTexts[cueIdx] = remembered
          continue
        }
        const linePrompt = buildLinePrompt(modelKey, source, false, translationMemory)
        const mt = maxTokensForModel(modelKey)

        let full = ''
        for await (const piece of llama.completionStream(linePrompt, {
          maxTokens: mt,
          temperature: 0.05,
        })) {
          full += piece
          win.webContents.send('translate:stream', {
            batchIndex: doneBatches,
            totalBatches: batches.length,
            partial: full,
          })
        }

        let out = cleanSingleLineOutput(source, full)
        const needsRetry =
          looksUntranslated(source, out) ||
          looksLikeGlossaryEcho(out) ||
          looksLikeRepetitionSpam(out) ||
          (modelKey === 'qwen27b' && out.length > 0 && !hasMyanmarChars(out))
        if (needsRetry) {
          let strictFull = ''
          const strictLinePrompt = buildLinePrompt(modelKey, source, true, translationMemory)
          for await (const piece of llama.completionStream(strictLinePrompt, {
            maxTokens: mt,
            temperature: 0,
          })) {
            strictFull += piece
          }
          out = cleanSingleLineOutput(source, strictFull)
          const stillBad =
            looksUntranslated(source, out) ||
            looksLikeGlossaryEcho(out) ||
            looksLikeRepetitionSpam(out) ||
            (modelKey === 'qwen27b' && out.length > 0 && !hasMyanmarChars(out))
          if (stillBad) {
            let bareStrictFull = ''
            const bareStrictPrompt = buildBareStrictLinePrompt(source)
            for await (const piece of llama.completionStream(bareStrictPrompt, {
              maxTokens: mt,
              temperature: 0,
            })) {
              bareStrictFull += piece
            }
            out = cleanSingleLineOutput(source, bareStrictFull)
          }
        }
        const expectedLines = splitCueLines(source).length
        if (expectedLines > 1 && splitCueLines(out).length < expectedLines) {
          const perLine = await translateMultilineCueByLine(llama, modelKey, source, translationMemory)
          if (perLine) out = perLine
        }

        if (
          out &&
          !looksUntranslated(source, out) &&
          !looksLikeGlossaryEcho(out) &&
          !looksLikeRepetitionSpam(out) &&
          (hasMyanmarChars(out) || modelKey !== 'qwen27b')
        ) {
          const stable = applyTranslationMemory(source, out, translationMemory)
          translatedTexts[cueIdx] = stable
          exactMemoryMap.set(normalizeForKey(source), stable)
        }
      }

      doneBatches += 1
      win.webContents.send('translate:progress', {
        batchIndex: doneBatches,
        totalBatches: batches.length,
        percent: Math.round((doneBatches / batches.length) * 100),
      })
    }

    return cloneCuesWithTexts(cues, translatedTexts)
  } catch (e) {
    if (e instanceof TranslationCancelled) {
      return cloneCuesWithTexts(cues, translatedTexts)
    }
    throw e
  }
}

/**
 * Translates a single cue with the same pipeline as full jobs.
 */
export async function runTranslateOneCue(
  win: BrowserWindow,
  llama: LlamaServerManager,
  opts: {
    cue: SubtitleCue
    modelKey: ModelId
    localModelFile?: string
    modelsDir: string
    nGpuLayers: number
    geminiApiKey?: string
    geminiModelId?: string
    openaiApiKey?: string
    openaiModelId?: string
    openaiTier?: OpenAiTier
    targetLanguage?: TranslationLanguage
    translationMemory?: TranslationMemoryEntry[]
  },
): Promise<string> {
  const { cue, modelKey, modelsDir, nGpuLayers } = opts
  const source = cue.text
  const translationMemory = opts.translationMemory ?? []
  const exactMemoryMap = buildExactMemoryMap(translationMemory)

  llama.beginInference()

  if (modelKey === 'gemini') {
    const key = opts.geminiApiKey?.trim()
    if (!key) {
      throw new Error(
        'Gemini API key is not set. Open the menu, paste your key from Google AI Studio, and click Save key.',
      )
    }
    return runGeminiTranslateOneCue(win, llama, {
      cue,
      apiKey: key,
      modelId: opts.geminiModelId,
      targetLanguage: opts.targetLanguage ?? 'myanmar',
      translationMemory,
    })
  }

  if (modelKey === 'openai') {
    const key = opts.openaiApiKey?.trim()
    if (!key) {
      throw new Error(
        'OpenAI API key is not set. Open the menu → Cloud → OpenAI, paste your key, and click Save key.',
      )
    }
    const tier = opts.openaiTier ?? 'normal'
    return runOpenAiTranslateOneCue(win, llama, {
      cue,
      apiKey: key,
      modelId: opts.openaiModelId,
      tier,
      targetLanguage: opts.targetLanguage ?? 'myanmar',
      translationMemory,
    })
  }

  const localModelFile =
    modelKey === 'local'
      ? opts.localModelFile?.trim() ?? ''
      : modelKey === 'qwen27b'
        ? MODEL_FILES.qwen27b
        : MODEL_FILES.qwen9b
  if (!localModelFile) {
    throw new Error('Select a local model file first.')
  }
  const localModelPath = path.join(modelsDir, localModelFile)
  if (!existsSync(localModelPath)) {
    throw new Error(
      `Missing model file for local model. Place ${localModelFile} in your models folder.`,
    )
  }

  const modelPath = localModelPath
  const engineDir = resourcesEngineDir()
  await llama.ensureRunning({ engineDir, modelPath, nGpuLayers })

  const mt = maxTokensForModel(modelKey)
  const remembered = exactMemoryMap.get(normalizeForKey(source))
  if (remembered) {
    return remembered
  }
  const linePrompt = buildLinePrompt(modelKey, source, false, translationMemory)

  let full = ''
  for await (const piece of llama.completionStream(linePrompt, {
    maxTokens: mt,
    temperature: 0.05,
  })) {
    full += piece
    win.webContents.send('translate:stream', {
      batchIndex: 0,
      totalBatches: 1,
      partial: full,
    })
  }

  let out = cleanSingleLineOutput(source, full)
  const needsRetry =
    looksUntranslated(source, out) ||
    looksLikeGlossaryEcho(out) ||
    looksLikeRepetitionSpam(out) ||
    (modelKey === 'qwen27b' && out.length > 0 && !hasMyanmarChars(out))
  if (needsRetry) {
    let strictFull = ''
    const strictLinePrompt = buildLinePrompt(modelKey, source, true, translationMemory)
    for await (const piece of llama.completionStream(strictLinePrompt, {
      maxTokens: mt,
      temperature: 0,
    })) {
      strictFull += piece
    }
    out = cleanSingleLineOutput(source, strictFull)
    const stillBad =
      looksUntranslated(source, out) ||
      looksLikeGlossaryEcho(out) ||
      looksLikeRepetitionSpam(out) ||
      (modelKey === 'qwen27b' && out.length > 0 && !hasMyanmarChars(out))
    if (stillBad) {
      let bareStrictFull = ''
      const bareStrictPrompt = buildBareStrictLinePrompt(source)
      for await (const piece of llama.completionStream(bareStrictPrompt, {
        maxTokens: mt,
        temperature: 0,
      })) {
        bareStrictFull += piece
      }
      out = cleanSingleLineOutput(source, bareStrictFull)
    }
  }
  const expectedLines = splitCueLines(source).length
  if (expectedLines > 1 && splitCueLines(out).length < expectedLines) {
    const perLine = await translateMultilineCueByLine(llama, modelKey, source, translationMemory)
    if (perLine) out = perLine
  }

  if (
    out &&
    !looksUntranslated(source, out) &&
    !looksLikeGlossaryEcho(out) &&
    !looksLikeRepetitionSpam(out) &&
    (hasMyanmarChars(out) || modelKey !== 'qwen27b')
  ) {
    return applyTranslationMemory(source, out, translationMemory)
  }
  return source
}
