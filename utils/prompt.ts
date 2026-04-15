import type { TranslationLanguage, TranslationMemoryEntry } from './types'

interface TargetLanguageMeta {
  label: string
  scriptHint: string
  outputLabel: string
}

function getTargetLanguageMeta(targetLanguage: TranslationLanguage): TargetLanguageMeta {
  if (targetLanguage === 'thai') {
    return {
      label: 'Thai',
      scriptHint: 'Thai script',
      outputLabel: 'Thai',
    }
  }
  return {
    label: 'Burmese',
    scriptHint: 'Myanmar script',
    outputLabel: 'Burmese',
  }
}

/**
 * Prompt template for English subtitle translation.
 * The batch text is inserted verbatim after "Input lines:\n".
 */
export function buildTranslationPrompt(
  subtitleBatch: string,
  targetLanguage: TranslationLanguage = 'myanmar',
  translationMemory: TranslationMemoryEntry[] = [],
): string {
  const meta = getTargetLanguageMeta(targetLanguage)
  const glossaryBlock =
    translationMemory.length > 0
      ? `\nTerminology memory (must follow when source phrase appears):\n${translationMemory
          .slice(0, 120)
          .map((entry) => `- "${entry.source}" => "${entry.target}"`)
          .join('\n')}\n`
      : ''
  return (
    `Task: Translate each numbered line from English to ${meta.label} (${meta.scriptHint}).\n` +
    'Rules:\n' +
    '- Keep numbering and order exactly.\n' +
    '- Translate every line; do not copy English source sentences.\n' +
    `- Translate person and place names into ${meta.scriptHint} (phonetic or usual form); do not leave names in English/Latin letters.\n` +
    '- Follow terminology memory exactly when matching source phrases appear.\n' +
    '- Output only numbered translated lines. No timestamps. No comments.\n\n' +
    glossaryBlock +
    'Input lines:\n' +
    subtitleBatch +
    '\n\n' +
    'Output format example:\n' +
    `1. [${meta.outputLabel} translation]\n` +
    `2. [${meta.outputLabel} translation]`
  )
}

export function buildStrictBurmesePrompt(
  subtitleBatch: string,
  targetLanguage: TranslationLanguage = 'myanmar',
  translationMemory: TranslationMemoryEntry[] = [],
): string {
  const meta = getTargetLanguageMeta(targetLanguage)
  const glossaryBlock =
    translationMemory.length > 0
      ? `\nTerminology memory (must follow exactly):\n${translationMemory
          .slice(0, 120)
          .map((entry) => `- "${entry.source}" => "${entry.target}"`)
          .join('\n')}\n`
      : ''
  return (
    'STRICT TRANSLATION MODE.\n' +
    `Translate each numbered line to ${meta.label} (${meta.scriptHint}) now, including names in ${meta.scriptHint}.\n` +
    'Apply terminology memory exactly when matching source phrases appear.\n' +
    'If you return English sentence copies, the answer is invalid.\n' +
    `Return exactly one ${meta.outputLabel} line per number in this format only:\n` +
    '1. ...\n2. ...\n3. ...\n\n' +
    glossaryBlock +
    'Input lines:\n' +
    subtitleBatch
  )
}

/**
 * Formats cue lines with indices so the model can return aligned numbered output.
 */
export function formatBatchForPrompt(lines: string[]): string {
  return lines.map((line, i) => `${i + 1}. ${line.replace(/\n/g, ' ').trim()}`).join('\n')
}
