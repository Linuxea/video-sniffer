import { DEFAULT_SETTINGS } from '../shared/settings'

const $ = (id: string) => document.getElementById(id) as HTMLInputElement
const status = $('status')

let saveTimer: ReturnType<typeof setTimeout> | null = null

function readForm() {
  return {
    concurrency: Math.max(1, Math.min(16, Number($('concurrency').value) || DEFAULT_SETTINGS.concurrency)),
    subfolder: $('subfolder').checked,
    preferMp4: $('preferMp4').checked,
  }
}

function scheduleSave() {
  status.textContent = ''
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      await chrome.storage.sync.set({ settings: readForm() })
      status.textContent = '✓ 已保存（新任务生效）'
    } catch (e: any) {
      status.textContent = `保存失败: ${e?.message ?? e}`
    }
  }, 300)
}

;(async () => {
  const { settings } = (await chrome.storage.sync.get('settings')) as any
  const s = { ...DEFAULT_SETTINGS, ...(settings ?? {}) }
  $('concurrency').value = String(s.concurrency)
  $('subfolder').checked = s.subfolder
  $('preferMp4').checked = s.preferMp4

  for (const id of ['concurrency', 'subfolder', 'preferMp4']) {
    $(id).addEventListener('change', scheduleSave)
  }
})()
