/**
 * llama.cpp integration: spawn `llama-server` (GGUF inference) and call its OpenAI-compatible HTTP API.
 *
 * Why llama-server (not Ollama):
 * - Official llama.cpp builds ship `llama-server.exe` with `/v1/chat/completions` and SSE streaming.
 * - We control GPU offload via `-ngl` and keep everything local/offline.
 *
 * Place `llama-server.exe` (and optional CUDA/Vulkan DLLs) under `/engine`. The packaged app
 * copies `/engine` via electron-builder `extraResources`.
 */

import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import { createConnection } from 'net'
import path from 'path'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createConnection({ host, port }, () => {
        s.end()
        resolve(true)
      })
      s.on('error', () => resolve(false))
    })
    if (ok) return
    await sleep(150)
  }
  throw new Error(`Timed out waiting for llama-server on ${host}:${port}`)
}

function findServerBinary(engineDir: string): string {
  const win = path.join(engineDir, 'llama-server.exe')
  if (fs.existsSync(win)) return win
  const unix = path.join(engineDir, 'llama-server')
  if (fs.existsSync(unix)) return unix
  throw new Error(
    `llama-server not found in ${engineDir}. Download a Windows llama.cpp release and place llama-server.exe in the /engine folder.`,
  )
}

async function getFreePort(): Promise<number> {
  const { createServer } = await import('net')
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      if (a && typeof a === 'object') {
        const p = a.port
        s.close(() => resolve(p))
      } else {
        s.close()
        reject(new Error('Could not allocate port'))
      }
    })
  })
}

/** Thrown when the user stops translation; partial results may already exist. */
export class TranslationCancelled extends Error {
  constructor() {
    super('Translation cancelled')
    this.name = 'TranslationCancelled'
  }
}

function parseSseChunks(
  buffer: string,
): { events: Array<{ data: string }>; rest: string } {
  const events: Array<{ data: string }> = []
  let rest = buffer
  const parts = buffer.split('\n\n')
  rest = parts.pop() ?? ''
  for (const block of parts) {
    const lines = block.split('\n').filter(Boolean)
    for (const line of lines) {
      if (line.startsWith('data:')) {
        events.push({ data: line.slice(5).trim() })
      }
    }
  }
  return { events, rest }
}

export class LlamaServerManager {
  private proc: ChildProcess | null = null
  private baseUrl: string | null = null
  private activeModelPath: string | null = null
  /** Mirrors last successful `-ngl` (0 = CPU-only; restart required when this changes). */
  private activeNGpuLayers: number | null = null
  private stderrBuf = ''
  /** User-requested stop for in-flight HTTP streams (translate / retranslate). */
  private inferenceCancelled = false
  private streamAbort: AbortController | null = null

  /** Call at the start of each translate / retranslate job. */
  beginInference(): void {
    this.inferenceCancelled = false
    try {
      this.streamAbort?.abort()
    } catch {
      /* ignore */
    }
    this.streamAbort = null
  }

  /** Stop current streaming request (full job or single line). */
  cancelInference(): void {
    this.inferenceCancelled = true
    try {
      this.streamAbort?.abort()
    } catch {
      /* ignore */
    }
  }

  isInferenceCancelled(): boolean {
    return this.inferenceCancelled
  }

  getBaseUrl(): string | null {
    return this.baseUrl
  }

  getActiveModelPath(): string | null {
    return this.activeModelPath
  }

  /**
   * Ensures a running server for the given GGUF path. Restarts if the model or CPU/GPU mode changed.
   */
  async ensureRunning(opts: {
    engineDir: string
    modelPath: string
    /** GPU layers to offload; 0 = CPU only */
    nGpuLayers: number
  }): Promise<string> {
    if (
      this.activeModelPath === opts.modelPath &&
      this.activeNGpuLayers === opts.nGpuLayers &&
      this.baseUrl &&
      this.proc
    ) {
      return this.baseUrl
    }
    await this.stop()

    if (!fs.existsSync(opts.modelPath)) {
      throw new Error(`Model file not found: ${opts.modelPath}`)
    }

    const binary = findServerBinary(opts.engineDir)
    const port = await getFreePort()
    const args: string[] = [
      '-m',
      opts.modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-c',
      '8192',
    ]
    if (opts.nGpuLayers > 0) {
      args.push('-ngl', String(opts.nGpuLayers))
    }

    this.stderrBuf = ''
    this.proc = spawn(binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    this.proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString()
      this.stderrBuf = (this.stderrBuf + s).slice(-8000)
    })
    this.proc.on('error', (err) => {
      this.stderrBuf += `\n[spawn error] ${String(err)}`
    })

    await waitForPort('127.0.0.1', port, 120_000)

    this.baseUrl = `http://127.0.0.1:${port}`
    this.activeModelPath = opts.modelPath
    this.activeNGpuLayers = opts.nGpuLayers
    return this.baseUrl
  }

  async stop(): Promise<void> {
    if (this.proc) {
      const p = this.proc
      this.proc = null
      this.baseUrl = null
      this.activeModelPath = null
      this.activeNGpuLayers = null
      try {
        p.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      await sleep(400)
      try {
        if (p.exitCode === null) p.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Streams plain completion tokens from llama-server `/completion`.
   * This is closer to `llama-cli -p ...` behavior and works better for some models.
   */
  async *completionStream(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): AsyncGenerator<string, void, unknown> {
    const base = this.baseUrl
    if (!base) throw new Error('llama-server is not running')

    const maxTokens = Math.max(32, Math.min(2048, Math.floor(opts?.maxTokens ?? 384)))
    const temperature = Number.isFinite(opts?.temperature)
      ? Math.max(0, Math.min(1.2, Number(opts?.temperature)))
      : 0.15

    let res: Response | null = null
    let lastErrText = ''
    const startMs = Date.now()
    const maxWarmupMs = 180_000
    const retryDelayMs = 1200

    while (Date.now() - startMs < maxWarmupMs) {
      if (this.inferenceCancelled) {
        throw new TranslationCancelled()
      }
      this.streamAbort = new AbortController()
      try {
        res = await fetch(`${base}/completion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            stream: true,
            n_predict: maxTokens,
            temperature,
          }),
          signal: this.streamAbort.signal,
        })
      } catch (e) {
        if (this.inferenceCancelled || (e instanceof Error && e.name === 'AbortError')) {
          throw new TranslationCancelled()
        }
        throw e
      }

      if (res.ok) break

      const t = await res.text().catch(() => '')
      lastErrText = t
      const isModelLoading =
        res.status === 503 &&
        (t.toLowerCase().includes('loading model') || t.toLowerCase().includes('unavailable_error'))
      if (!isModelLoading) {
        throw new Error(
          `llama-server /completion failed: HTTP ${res.status} ${t.slice(0, 500)}\n${this.stderrBuf.slice(-2000)}`,
        )
      }
      if (this.inferenceCancelled) {
        throw new TranslationCancelled()
      }
      await sleep(retryDelayMs)
    }

    if (!res || !res.ok) {
      throw new Error(
        `llama-server completion warm-up timed out after ${Math.round(maxWarmupMs / 1000)}s. Last response: ${lastErrText.slice(0, 500)}\n${this.stderrBuf.slice(-2000)}`,
      )
    }
    if (!res.body) {
      throw new Error('llama-server returned empty body')
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let carry = ''

    while (true) {
      if (this.inferenceCancelled) {
        await reader.cancel().catch(() => {})
        throw new TranslationCancelled()
      }
      const { done, value } = await reader.read()
      if (done) break
      carry += decoder.decode(value, { stream: true })
      const { events, rest } = parseSseChunks(carry + '\n\n')
      carry = rest
      for (const ev of events) {
        if (ev.data === '[DONE]') continue
        try {
          const j = JSON.parse(ev.data) as { content?: string; delta?: string }
          const piece = j.content ?? j.delta
          if (piece) yield piece
        } catch {
          /* ignore malformed JSON fragments */
        }
      }
    }

    if (carry.trim()) {
      const { events } = parseSseChunks(carry + '\n\n')
      for (const ev of events) {
        if (ev.data === '[DONE]') continue
        try {
          const j = JSON.parse(ev.data) as { content?: string; delta?: string }
          const piece = j.content ?? j.delta
          if (piece) yield piece
        } catch {
          /* ignore */
        }
      }
    }
  }

  getRecentLogs(): string {
    return this.stderrBuf
  }
}
