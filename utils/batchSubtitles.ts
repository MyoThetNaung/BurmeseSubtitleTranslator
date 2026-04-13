/**
 * Group subtitle cues into batches (5–10 cues per request) for LLM context.
 */

import type { SubtitleCue } from './types'

export interface SubtitleBatch {
  /** Global cue indices in the original array (0-based). */
  cueIndices: number[]
  /** One string per cue (newlines inside a cue preserved). */
  lines: string[]
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Builds batches of `targetPerBatch` cues (clamped to 5–10).
 */
export function buildBatches(cues: SubtitleCue[], targetPerBatch = 7): SubtitleBatch[] {
  const size = clamp(targetPerBatch, 5, 10)
  const batches: SubtitleBatch[] = []
  for (let i = 0; i < cues.length; i += size) {
    const slice = cues.slice(i, i + size)
    batches.push({
      cueIndices: slice.map((_, j) => i + j),
      lines: slice.map((c) => c.text),
    })
  }
  return batches
}
