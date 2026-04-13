/// <reference types="vite/client" />

import type { SubtitleAppApi } from '../../preload/index'

declare global {
  interface Window {
    subtitleApp: SubtitleAppApi
  }
}

export {}
