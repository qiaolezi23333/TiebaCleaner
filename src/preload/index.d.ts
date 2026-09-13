import type { TiebaAPI } from './index'

declare global {
  interface Window {
    tieba: TiebaAPI
  }
}

export {}
