/**
 * RAM and GPU summary for diagnostics / future UI use.
 */

import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface SystemInfo {
  totalRamGb: number
  freeRamGb: number
  gpuNames: string[]
  platform: NodeJS.Platform
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const totalRamGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
  const freeRamGb = Math.round((os.freemem() / 1024 ** 3) * 10) / 10
  let gpuNames: string[] = []

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
        ],
        { windowsHide: true, timeout: 12000 },
      )
      gpuNames = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    } catch {
      gpuNames = []
    }
  }

  return {
    totalRamGb,
    freeRamGb,
    gpuNames,
    platform: process.platform,
  }
}
