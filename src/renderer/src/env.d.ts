/// <reference types="vite/client" />

import type { QaNativeApi } from '@shared/contracts'

declare global {
  interface Window {
    qaNative?: QaNativeApi
  }
}

export {}
