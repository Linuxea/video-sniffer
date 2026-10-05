import type { MediaResource } from '../shared/types'
import { hashUrl, classifyUrl } from '../shared/types'

interface TabData {
  meta: { url: string; title: string }
  /** id → resource */
  resources: Map<string, MediaResource>
  /** url → id */
  byUrl: Map<string, string>
}

const MAX_PER_TAB = 200

/**
 * 每个 tab 的嗅探结果注册表。
 * 内存为主 + chrome.storage.session 持久化（SW 随时可能被回收）。
 */
class ResourceStore {
  private tabs = new Map<number, TabData>()
  private dirty = new Set<number>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private tab(tabId: number): TabData {
    let t = this.tabs.get(tabId)
    if (!t) {
      t = { meta: { url: '', title: '' }, resources: new Map(), byUrl: new Map() }
      this.tabs.set(tabId, t)
    }
    return t
  }

  /** SW 冷启动时从 storage.session 恢复 */
  async restore() {
    try {
      const all = await chrome.storage.session.get(null)
      for (const [k, v] of Object.entries(all)) {
        let m = k.match(/^res:(\d+)$/)
        if (m && Array.isArray(v)) {
          const tabId = Number(m[1])
          const t = this.tab(tabId)
          for (const r of v as MediaResource[]) {
            t.resources.set(r.id, r)
            t.byUrl.set(r.url, r.id)
          }
        }
        m = k.match(/^meta:(\d+)$/)
        if (m && v) this.tab(Number(m[1])).meta = v as TabData['meta']
      }
    } catch {
      /* ignore */
    }
  }

  /** content script 上报页面上下文；页面发生导航时清空旧资源 */
  setPageContext(tabId: number, url: string, title: string): boolean {
    const t = this.tab(tabId)
    const navigated = t.meta.url !== '' && t.meta.url !== url
    t.meta = { url, title }
    if (navigated) {
      t.resources.clear()
      t.byUrl.clear()
    }
    this.schedule(tabId)
    return navigated
  }

  getMeta(tabId: number) {
    return this.tabs.get(tabId)?.meta ?? { url: '', title: '' }
  }

  add(tabId: number, res: MediaResource): boolean {
    const t = this.tab(tabId)
    const id = res.id || `${tabId}:${hashUrl(res.url)}`
    const existing = t.byUrl.get(res.url)
    if (existing) {
      // 已存在：补充元信息
      const old = t.resources.get(existing)
      if (old) {
        for (const k of ['contentType', 'sizeBytes', 'duration', 'width', 'height'] as const) {
          if ((old as any)[k] == null && (res as any)[k] != null) (old as any)[k] = (res as any)[k]
        }
      }
      return false
    }
    const entry: MediaResource = { ...res, id }
    t.resources.set(id, entry)
    t.byUrl.set(res.url, id)
    // 容量控制
    if (t.resources.size > MAX_PER_TAB) {
      const sorted = [...t.resources.values()].sort((a, b) => a.capturedAt - b.capturedAt)
      for (const r of sorted.slice(0, t.resources.size - MAX_PER_TAB)) {
        t.resources.delete(r.id)
        t.byUrl.delete(r.url)
      }
    }
    this.schedule(tabId)
    return true
  }

  /** onHeadersReceived 到达后补充 content-type / size 等 */
  updateByUrl(tabId: number, url: string, patch: Partial<MediaResource>): boolean {
    const t = this.tabs.get(tabId)
    if (!t) return false
    const id = t.byUrl.get(url)
    if (!id) return false
    const res = t.resources.get(id)
    if (!res) return false
    Object.assign(res, patch)
    this.schedule(tabId)
    return true
  }

  /** 重定向：旧地址条目换成新地址 */
  supersede(tabId: number, oldUrl: string, newUrl: string) {
    const t = this.tabs.get(tabId)
    if (!t) return
    const id = t.byUrl.get(oldUrl)
    if (!id) return
    const res = t.resources.get(id)
    if (!res) return
    t.byUrl.delete(oldUrl)
    res.url = newUrl
    t.byUrl.set(newUrl, id)
    this.schedule(tabId)
  }

  get(tabId: number, id: string): MediaResource | undefined {
    return this.tabs.get(tabId)?.resources.get(id)
  }

  /**
   * popup 展示列表：按捕获时间倒序；
   * 若 tab 内已抓到 m3u8/mpd，则隐藏零散分片条目（被 playlist 吸收）。
   */
  listVisible(tabId: number): MediaResource[] {
    const t = this.tabs.get(tabId)
    if (!t) return []
    const arr = [...t.resources.values()].sort((a, b) => b.capturedAt - a.capturedAt)
    const hasStream = arr.some((r) => r.kind === 'hls' || r.kind === 'dash')
    return arr.filter((r) => !(hasStream && r.kind === 'segment'))
  }

  async clear(tabId: number) {
    this.tabs.delete(tabId)
    this.dirty.delete(tabId)
    try {
      await chrome.storage.session.remove([`res:${tabId}`, `meta:${tabId}`])
    } catch {
      /* ignore */
    }
  }

  /** tab 关闭时清理（不动下载任务） */
  onTabRemoved(tabId: number) {
    this.tabs.delete(tabId)
    this.dirty.delete(tabId)
    chrome.storage.session.remove([`res:${tabId}`, `meta:${tabId}`]).catch(() => {})
  }

  private schedule(tabId: number) {
    this.dirty.add(tabId)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 400)
  }

  private async flush() {
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const tabId of ids) {
      const t = this.tabs.get(tabId)
      if (!t) continue
      try {
        await chrome.storage.session.set({
          [`res:${tabId}`]: [...t.resources.values()],
          [`meta:${tabId}`]: t.meta,
        })
      } catch {
        /* ignore */
      }
    }
  }
}

export const store = new ResourceStore()

/** 把 content script 的 DOM 扫描结果合入注册表 */
export function mergeDomItems(
  tabId: number,
  items: { url: string; duration?: number; width?: number; height?: number; transferSize?: number }[],
): boolean {
  const meta = store.getMeta(tabId)
  let added = false
  for (const it of items) {
    const c = classifyUrl(it.url)
    const kind = c ? c.kind : it.url.startsWith('blob:') ? 'blob' : null
    if (!kind) continue
    added =
      store.add(tabId, {
        id: '',
        url: it.url,
        kind,
        ext: c ? c.ext : '',
        capturedAt: Date.now(),
        source: 'dom',
        pageUrl: meta.url,
        duration: it.duration,
        width: it.width,
        height: it.height,
        sizeBytes: it.transferSize,
      }) || added
  }
  return added
}
