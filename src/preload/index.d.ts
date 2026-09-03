import type { QaNativeApi } from '../shared/contracts.js'

declare global {
  interface Window {
    qaNative?: QaNativeApi
  }
}

export {}
