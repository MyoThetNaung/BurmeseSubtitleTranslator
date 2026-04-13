/**
 * Resolves bundled resources (models, llama.cpp binaries) in dev and packaged builds.
 * Prefers a user-local models directory (AppData) when configured for faster I/O (e.g. USB installs).
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const MODEL_FILES = {
  /** Smaller / faster (e.g. Qwen3 9B-class GGUF). */
  qwen9b: 'qwen3_5_9b.gguf',
  /** Qwen3.5-27B Instruct Q4_K_M — higher quality, heavier. */
  qwen27b: 'Qwen3.5-27B-Q4_K_M.gguf',
} as const

export type ModelKey = keyof typeof MODEL_FILES

function projectRootModels(): string {
  // out/main -> ../../../models (repo root)
  return path.join(__dirname, '../../../models')
}

function projectRootEngine(): string {
  return path.join(__dirname, '../../../engine')
}

export function resourcesModelsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models')
  }
  return projectRootModels()
}

export function resourcesEngineDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'engine')
  }
  return projectRootEngine()
}

/** Preferred local cache: %APPDATA%/<app name>/models */
export function userDataModelsDir(): string {
  return path.join(app.getPath('userData'), 'models')
}

/**
 * Returns the directory to read GGUF files from.
 * `override` comes from config when user chose to copy models to AppData.
 */
export function resolveModelsDirectory(configuredDir?: string | null): string {
  if (configuredDir && fs.existsSync(configuredDir)) {
    return configuredDir
  }
  const local = userDataModelsDir()
  if (fs.existsSync(local) && fs.readdirSync(local).some((f) => f.endsWith('.gguf'))) {
    return local
  }
  return resourcesModelsDir()
}

/** Alias used by IPC + translator to pick AppData vs bundled models. */
export function resolveDefaultModelsDir(configuredDir?: string | null): string {
  return resolveModelsDirectory(configuredDir)
}

export function resolveModelPath(modelKey: ModelKey, modelsDir: string): string {
  const file = MODEL_FILES[modelKey]
  return path.join(modelsDir, file)
}

export function modelExists(modelKey: ModelKey, modelsDir: string): boolean {
  const p = resolveModelPath(modelKey, modelsDir)
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Windows: returns true if the drive hosting `absolutePath` is removable (typical USB).
 */
export async function isOnRemovableDrive(absolutePath: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const root = path.parse(path.resolve(absolutePath)).root
  if (!root || root === '/') return false
  const drive = root.replace(/\\$/, '')
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(New-Object System.IO.DriveInfo '${drive.replace(/'/g, "''")}').DriveType`,
      ],
      { windowsHide: true, timeout: 8000 },
    )
    const v = stdout.trim()
    // Removable == 2
    return v === '2' || v.toLowerCase().includes('removable')
  } catch {
    return false
  }
}

export async function shouldSuggestCopyModelsToAppData(): Promise<boolean> {
  const exe = app.getPath('exe')
  const onUsb = await isOnRemovableDrive(exe)
  const bundled = resourcesModelsDir()
  const hasGguf =
    fs.existsSync(bundled) &&
    fs.readdirSync(bundled).some((f) => f.endsWith('.gguf') && !f.startsWith('.'))
  return onUsb && hasGguf
}

/**
 * Copies *.gguf from bundled/resources models dir into AppData models (faster random read).
 */
export async function copyBundledModelsToUserData(): Promise<string> {
  const dest = userDataModelsDir()
  await fs.promises.mkdir(dest, { recursive: true })
  const src = resourcesModelsDir()
  if (!fs.existsSync(src)) {
    throw new Error(`Bundled models folder missing: ${src}`)
  }
  const files = await fs.promises.readdir(src)
  for (const name of files) {
    if (!name.endsWith('.gguf')) continue
    const from = path.join(src, name)
    const to = path.join(dest, name)
    await fs.promises.copyFile(from, to)
  }
  return dest
}
