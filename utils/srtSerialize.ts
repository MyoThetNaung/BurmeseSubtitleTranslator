/**
 * Serialize subtitle cues back to valid .srt (SubRip) text.
 */

import type { SubtitleCue } from './types'

function formatMs(ms: number): string {
  if (ms < 0) ms = 0
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const milli = ms % 1000
  const pad = (n: number, w: number) => n.toString().padStart(w, '0')
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`
}

export function serializeSrt(cues: SubtitleCue[]): string {
  const parts: string[] = []
  cues.forEach((cue, idx) => {
    const n = idx + 1
    parts.push(
      `${n}\n${formatMs(cue.startMs)} --> ${formatMs(cue.endMs)}\n${cue.text}\n`,
    )
  })
  return parts.join('\n')
}
