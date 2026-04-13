/**
 * English → Burmese subtitle translation via Google Gemini API (cloud).
 */

import { GoogleGenerativeAI } from '@google/generative-ai'
import type { SubtitleCue } from '@utils/types'
import { buildBatches } from '@utils/batchSubtitles'
import {
  buildStrictBurmesePrompt,
  buildTranslationPrompt,
  formatBatchForPrompt,
} from '@utils/prompt'
import { parseTranslatedLines } from '@utils/parseModelOutput'
import { LlamaServerManager, TranslationCancelled } from './llamaServer'
import type { BrowserWindow } from 'electron'

function geminiModelName(): string {
  const raw = process.env.SUBTITLE_GEMINI_MODEL
  if (raw && raw.trim()) return raw.trim()
  // gemini-2.0-flash is not available to new API keys; 2.5 Flash is the current default.
  return 'gemini-2.5-flash'
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

function cloneCuesWithTexts(cues: SubtitleCue[], texts: string[]): SubtitleCue[] {
  return cues.map((c, i) => ({
    ...c,
    text: texts[i] ?? c.text,
  }))
}

export async function runGeminiTranslateJob(
  win: BrowserWindow,
  llama: LlamaServerManager,
  opts: { cues: SubtitleCue[]; apiKey: string },
): Promise<SubtitleCue[]> {
  const { cues, apiKey } = opts
  const fastMode = process.env.SUBTITLE_FAST_TEST === '1'
  const linesPerBatch = fastMode ? 3 : 7

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: geminiModelName() })

  const batches = buildBatches(cues, linesPerBatch)
  const translatedTexts: string[] = cues.map((c) => c.text)

  let doneBatches = 0
  try {
    for (const batch of batches) {
      if (llama.isInferenceCancelled()) {
        throw new TranslationCancelled()
      }

      const subtitleBatch = formatBatchForPrompt(batch.lines)
      let prompt = buildTranslationPrompt(subtitleBatch)

      const runStream = async (p: string): Promise<string> => {
        const stream = await model.generateContentStream({
          contents: [{ role: 'user', parts: [{ text: p }] }],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.15,
          },
        })
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
        (acc, line, i) => acc + (looksUntranslated(batch.lines[i] ?? '', line ?? '') ? 1 : 0),
        0,
      )
      const shouldRetryStrict =
        suspiciousCount >= Math.max(1, Math.ceil(batch.lines.length * 0.6))

      if (shouldRetryStrict) {
        prompt = buildStrictBurmesePrompt(subtitleBatch)
        full = await runStream(prompt)
        outLines = parseTranslatedLines(full, batch.lines.length)
      }

      for (let i = 0; i < batch.cueIndices.length; i++) {
        const cueIdx = batch.cueIndices[i]
        const next = outLines[i]
        if (
          typeof next === 'string' &&
          next.trim().length > 0 &&
          !looksUntranslated(batch.lines[i] ?? '', next)
        ) {
          translatedTexts[cueIdx] = next
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
  opts: { cue: SubtitleCue; apiKey: string },
): Promise<string> {
  const { cue, apiKey } = opts
  const source = cue.text

  if (llama.isInferenceCancelled()) {
    throw new TranslationCancelled()
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: geminiModelName() })

  const userPrompt =
    'Translate the subtitle line to Burmese (Myanmar script), including person and place names in Burmese script. Output only Burmese text, one line.\n' +
    `English: ${source}\n` +
    'Burmese:'

  const stream = await model.generateContentStream({
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
  })

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
  const myanmarLine = lines.find((l) => hasMyanmarChars(l))
  const pick = myanmarLine ?? lines[lines.length - 1] ?? ''
  const out = pick.replace(/^\s*(\d+)\s*[\.\)]\s*/, '').trim()

  if (out && !looksUntranslated(source, out)) return out
  return source
}
