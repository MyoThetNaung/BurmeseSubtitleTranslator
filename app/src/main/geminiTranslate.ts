/**
 * English → Burmese subtitle translation via Google Gemini API (cloud).
 */

import { GoogleGenerativeAI } from '@google/generative-ai'
import type { SubtitleCue, TranslationLanguage, TranslationMemoryEntry } from '@utils/types'
import { buildBatches } from '@utils/batchSubtitles'
import {
  buildStrictBurmesePrompt,
  buildTranslationPrompt,
  formatBatchForPrompt,
} from '@utils/prompt'
import { parseTranslatedLines } from '@utils/parseModelOutput'
import { LlamaServerManager, TranslationCancelled } from './llamaServer'
import type { BrowserWindow } from 'electron'

function geminiModelName(preferred?: string): string {
  if (preferred && preferred.trim()) return preferred.trim()
  const raw = process.env.SUBTITLE_GEMINI_MODEL
  if (raw && raw.trim()) return raw.trim()
  // gemini-2.0-flash is not available to new API keys; 2.5 Flash is the current default.
  return 'gemini-2.5-flash'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isGeminiTransientError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return (
    /\b503\b/.test(msg) ||
    /Service Unavailable/i.test(msg) ||
    /high demand/i.test(msg) ||
    /\b429\b/.test(msg) ||
    /resource exhausted/i.test(msg) ||
    /rate limit/i.test(msg)
  )
}

async function generateContentStreamWithRetry(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  prompt: string,
  maxOutputTokens: number,
  temperature: number,
): Promise<Awaited<ReturnType<typeof model.generateContentStream>>> {
  const attempts = [0, 1200, 2600, 5200]
  let lastError: unknown = null
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) await sleep(attempts[i])
    try {
      return await model.generateContentStream({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens,
          temperature,
        },
      })
    } catch (error) {
      lastError = error
      if (!isGeminiTransientError(error) || i === attempts.length - 1) {
        throw error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function hasMyanmarChars(input: string): boolean {
  return /[\u1000-\u109f]/.test(input)
}

function normalizeForCompare(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksUntranslated(source: string, translated: string): boolean {
  const out = translated.trim()
  if (!out) return true
  if (hasMyanmarChars(out)) return false
  return normalizeForCompare(source) === normalizeForCompare(out)
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

function applyTranslationMemory(
  source: string,
  translated: string,
  memory: TranslationMemoryEntry[],
): string {
  const exact = buildExactMemoryMap(memory).get(normalizeForKey(source))
  if (exact) return exact
  return translated
}

function cloneCuesWithTexts(cues: SubtitleCue[], texts: string[]): SubtitleCue[] {
  return cues.map((c, i) => ({
    ...c,
    text: texts[i] ?? c.text,
  }))
}

export async function runGeminiTranslateJob(
  win: BrowserWindow,
  llama: LlamaServerManager,
  opts: {
    cues: SubtitleCue[]
    apiKey: string
    modelId?: string
    targetLanguage: TranslationLanguage
    translationMemory: TranslationMemoryEntry[]
  },
): Promise<SubtitleCue[]> {
  const { cues, apiKey, modelId, targetLanguage, translationMemory } = opts
  const fastMode = process.env.SUBTITLE_FAST_TEST === '1'
  const linesPerBatch = fastMode ? 3 : 7

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: geminiModelName(modelId) })

  const batches = buildBatches(cues, linesPerBatch)
  const translatedTexts: string[] = cues.map((c) => c.text)
  const exactMemoryMap = buildExactMemoryMap(translationMemory)

  let doneBatches = 0
  try {
    for (const batch of batches) {
      if (llama.isInferenceCancelled()) {
        throw new TranslationCancelled()
      }

      const subtitleBatch = formatBatchForPrompt(batch.lines)
      let prompt = buildTranslationPrompt(subtitleBatch, targetLanguage, translationMemory)

      const runStream = async (p: string): Promise<string> => {
        const stream = await generateContentStreamWithRetry(model, p, 4096, 0.15)
        let acc = ''
        for await (const chunk of stream.stream) {
          if (llama.isInferenceCancelled()) {
            throw new TranslationCancelled()
          }
          const t = chunk.text()
          acc += t
          win.webContents.send('translate:stream', {
            batchIndex: doneBatches,
            totalBatches: batches.length,
            partial: acc,
          })
        }
        return acc
      }

      let full = await runStream(prompt)
      let outLines = parseTranslatedLines(full, batch.lines.length)

      const suspiciousCount = outLines.reduce(
        (acc: number, line: string, i: number) =>
          acc + (looksUntranslated(batch.lines[i] ?? '', line ?? '') ? 1 : 0),
        0,
      )
      const shouldRetryStrict =
        suspiciousCount >= Math.max(1, Math.ceil(batch.lines.length * 0.6))

      if (shouldRetryStrict) {
        prompt = buildStrictBurmesePrompt(subtitleBatch, targetLanguage, translationMemory)
        full = await runStream(prompt)
        outLines = parseTranslatedLines(full, batch.lines.length)
      }

      for (let i = 0; i < batch.cueIndices.length; i++) {
        const cueIdx = batch.cueIndices[i]
        const source = batch.lines[i] ?? ''
        const remembered = exactMemoryMap.get(normalizeForKey(source))
        if (remembered) {
          translatedTexts[cueIdx] = remembered
          continue
        }
        const next = outLines[i]
        if (
          typeof next === 'string' &&
          next.trim().length > 0 &&
          !looksUntranslated(source, next)
        ) {
          const stable = applyTranslationMemory(source, next, translationMemory)
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

export async function runGeminiTranslateOneCue(
  win: BrowserWindow,
  llama: LlamaServerManager,
  opts: {
    cue: SubtitleCue
    apiKey: string
    modelId?: string
    targetLanguage: TranslationLanguage
    translationMemory: TranslationMemoryEntry[]
  },
): Promise<string> {
  const { cue, apiKey, modelId, targetLanguage, translationMemory } = opts
  const source = cue.text

  if (llama.isInferenceCancelled()) {
    throw new TranslationCancelled()
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: geminiModelName(modelId) })
  const remembered = buildExactMemoryMap(translationMemory).get(normalizeForKey(source))
  if (remembered) return remembered

  const targetLabel = targetLanguage === 'thai' ? 'Thai' : 'Burmese'
  const targetScript = targetLanguage === 'thai' ? 'Thai script' : 'Myanmar script'
  const userPrompt =
    `Translate the subtitle line to ${targetLabel} (${targetScript}), including person and place names in ${targetScript}. Output only ${targetLabel} text, one line.\n` +
    (translationMemory.length
      ? `Terminology memory (must follow if source phrase appears):\n${translationMemory
          .slice(0, 120)
          .map((entry) => `- "${entry.source}" => "${entry.target}"`)
          .join('\n')}\n`
      : '') +
    `English: ${source}\n` +
    `${targetLabel}:`

  const stream = await generateContentStreamWithRetry(model, userPrompt, 512, 0.1)

  let full = ''
  for await (const chunk of stream.stream) {
    if (llama.isInferenceCancelled()) {
      throw new TranslationCancelled()
    }
    const t = chunk.text()
    full += t
    win.webContents.send('translate:stream', {
      batchIndex: 0,
      totalBatches: 1,
      partial: full,
    })
  }

  const lines = full
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const targetScriptLine =
    targetLanguage === 'thai'
      ? lines.find((l) => /[\u0E00-\u0E7F]/.test(l))
      : lines.find((l) => hasMyanmarChars(l))
  const pick = targetScriptLine ?? lines[lines.length - 1] ?? ''
  const out = pick.replace(/^\s*(\d+)\s*[\.\)]\s*/, '').trim()

  if (out && !looksUntranslated(source, out)) return applyTranslationMemory(source, out, translationMemory)
  return source
}
