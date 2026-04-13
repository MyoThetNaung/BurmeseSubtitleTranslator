/**
 * Parse SubRip (.srt) files into structured cues.
 * Preserves line breaks inside a cue as \n for round-trip export.
 */

import type { SubtitleCue } from './types'

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/

function parseTimestamp(h: string, m: string, s: string, ms: string): number {
  return (
    (parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000 +
    parseInt(ms, 10)
  )
}

/**
 * Normalizes Windows/Mac newlines to \n before parsing.
 */
export function parseSrt(raw: string): SubtitleCue[] {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!text) return []

  const blocks = text.split(/\n\n+/)
  const cues: SubtitleCue[] = []

  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines.length < 2) continue

    let i = 0
    const first = lines[i].trim()
    if (/^\d+$/.test(first)) {
      i += 1
    }
    if (i >= lines.length) continue

    const timeLine = lines[i]
    const m = timeLine.match(TIME_RE)
    if (!m) continue

    const startMs = parseTimestamp(m[1], m[2], m[3], m[4])
    const endMs = parseTimestamp(m[5], m[6], m[7], m[8])
    i += 1

    const bodyLines = lines.slice(i)
    const body = bodyLines.join('\n').trimEnd()

    const index =
      /^\d+$/.test(first) && !timeLine.includes('-->') ? parseInt(first, 10) : cues.length + 1

    cues.push({
      index,
      startMs,
      endMs,
      text: body,
    })
  }

  return cues
}
