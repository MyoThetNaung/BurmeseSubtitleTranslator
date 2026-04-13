/**
 * Prompt template for English → Burmese subtitle translation (per product spec).
 * The batch text is inserted verbatim after "Text:\n".
 */

export function buildTranslationPrompt(subtitleBatch: string): string {
  return (
    'Task: Translate each numbered line from English to Burmese (Myanmar script).\n' +
    'Rules:\n' +
    '- Keep numbering and order exactly.\n' +
    '- Translate every line; do not copy English source sentences.\n' +
    '- Translate person and place names into Burmese script (phonetic or usual form); do not leave names in English/Latin letters.\n' +
    '- Output only numbered translated lines. No timestamps. No comments.\n\n' +
    'Input lines:\n' +
    subtitleBatch +
    '\n\n' +
    'Output format example:\n' +
    '1. [Burmese translation]\n' +
    '2. [Burmese translation]'
  )
}

export function buildStrictBurmesePrompt(subtitleBatch: string): string {
  return (
    'STRICT TRANSLATION MODE.\n' +
    'Translate each numbered line to Burmese (Myanmar script) now, including names in Burmese script.\n' +
    'If you return English sentence copies, the answer is invalid.\n' +
    'Return exactly one Burmese line per number in this format only:\n' +
    '1. ...\n2. ...\n3. ...\n\n' +
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
