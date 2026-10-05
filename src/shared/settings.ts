import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  concurrency: 6,
  subfolder: true,
  preferMp4: true,
}

export async function getSettings(): Promise<Settings> {
  try {
    const { settings } = await chrome.storage.sync.get('settings')
    return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}
