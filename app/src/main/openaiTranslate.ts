/**
 * English → Burmese subtitle translation via OpenAI API (cloud).
 * Uses the Responses API with streaming — recommended for GPT-5 family models
 * (Chat Completions streaming is unreliable for some of these models).
 */

import OpenAI from 'openai'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import type {
  OpenAiTier,
  SubtitleCue,
  TranslationLanguage,
  TranslationMemoryEntry,
} from '@utils/types'
import { buildBatches } from '@utils/batchSubtitles'
import {
  buildStrictBurmesePrompt,
  buildTranslationPrompt,
  formatBatchForPrompt,
} from '@utils/prompt'
import { parseTranslatedLines } from '@utils/parseModelOutput'
import { LlamaServerManager, TranslationCancelled } from './llamaServer'
import type { BrowserWindow } from 'electron'

function openAiModelForTier(tier: OpenAiTier, preferred?: string): string {
  if (preferred && preferred.trim()) return preferred.trim()
  if (tier === 'premium') {
    const raw = process.env.SUBTITLE_OPENAI_MODEL_PREMIUM
    if (raw && raw.trim()) return raw.trim()
    return 'gpt-5'
  }
  const raw = process.env.SUBTITLE_OPENAI_MODEL_NORMAL
  if (raw && raw.trim()) return raw.trim()
  return 'gpt-5-mini'
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

function appendResponsesStreamText(acc: string, event: ResponseStreamEvent): string {
  if (event.type === 'response.output_text.delta') {
    return acc + event.delta
  }
  return acc
}

export async function runOpenAiTranslateJob(
  win: BrowserWindow,
  llama: LlamaServerManager,
  opts: {
    cues: SubtitleCue[]
    apiKey: string
    modelId?: string
    tier: OpenAiTier
    targetLanguage: TranslationLanguage
    translationMemory: TranslationMemoryEntry[]
  },
): Promise<SubtitleCue[]> {
  const { cues, apiKey, modelId, tier, targetLanguage, translationMemory } = opts
  const fastMode = process.env.SUBTITLE_FAST_TEST === '1'
  const linesPerBatch = fastMode ? 3 : 7

  const client = new OpenAI({ apiKey })
  const model = openAiModelForTier(tier, modelId)

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
        const stream = await client.responses.create({
          model,
          instructions:
            'You are a professional subtitle translator. Follow the user format exactly; no preamble or commentary.',
          input: p,
          stream: true,
          max_output_tokens: 4096,
        })
        let acc = ''
        for await (const event of stream) {
          if (llama.isInferenceCancelled()) {
            throw new TranslationCancelled()
          }
          if (event.type === 'error') {
            throw new Error(event.message || 'OpenAI API error')
          }
          acc = appendResponsesStreamText(acc, event)
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
        (acc, line, i) => acc + (looksUntranslated(batch.lines[i] ?? '', line ?? '') ? 1 : 0),
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

export async function runOpenAiTranslateOneCue(
  win: BrowserWindow,
  llama: LlamaServerManager,
  opts: {
    cue: SubtitleCue
    apiKey: string
    modelId?: string
    tier: OpenAiTier
    targetLanguage: TranslationLanguage
    translationMemory: TranslationMemoryEntry[]
  },
): Promise<string> {
  const { cue, apiKey, modelId, tier, targetLanguage, translationMemory } = opts
  const source = cue.text

  if (llama.isInferenceCancelled()) {
    throw new TranslationCancelled()
  }

  const client = new OpenAI({ apiKey })
  const model = openAiModelForTier(tier, modelId)
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

  const stream = await client.responses.create({
    model,
    instructions:
      'You are a professional subtitle translator. Output only the requested Burmese line.',
    input: userPrompt,
    stream: true,
    max_output_tokens: 512,
  })

  let full = ''
  for await (const event of stream) {
    if (llama.isInferenceCancelled()) {
      throw new TranslationCancelled()
    }
    if (event.type === 'error') {
      throw new Error(event.message || 'OpenAI API error')
    }
    full = appendResponsesStreamText(full, event)
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
