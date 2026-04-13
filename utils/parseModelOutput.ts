/**
 * Extract translated lines from llama.cpp chat output.
 * Expects one translation per input line, optionally prefixed with "N."
 */

export function parseTranslatedLines(modelText: string, expectedCount: number): string[] {
  const raw = modelText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!raw) {
    return Array(expectedCount).fill('')
  }

  const numbered: string[] = []
  const re = /^\s*(\d+)\s*[\.\)]\s*(.*)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const idx = parseInt(m[1], 10) - 1
    if (idx >= 0 && idx < expectedCount) {
      numbered[idx] = m[2].trim()
    }
  }

  if (numbered.filter(Boolean).length >= Math.min(expectedCount, 1)) {
    const out: string[] = []
    for (let i = 0; i < expectedCount; i++) {
      out.push(numbered[i] ?? '')
    }
    return out
  }

  // Fallback: non-empty lines in order (strip leading bullets)
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/^\s*(\d+)[\.\)]\s*/, '').trim())
    .filter((l) => l.length > 0)

  if (lines.length === expectedCount) {
    return lines
  }

  if (lines.length > expectedCount) {
    return lines.slice(0, expectedCount)
  }

  const padded = [...lines]
  while (padded.length < expectedCount) {
    padded.push('')
  }
  return padded
}
