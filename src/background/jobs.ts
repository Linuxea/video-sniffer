import type { DownloadJob, JobStatus } from '../shared/types'

const MAX_JOBS = 50
const ACTIVE: JobStatus[] = ['preparing', 'downloading', 'muxing', 'saving']

function isActive(j: DownloadJob) {
  return ACTIVE.includes(j.status)
}

/** 下载任务管理：内存 + chrome.storage.local 持久化（popup 重开可恢复进度） */
class JobManager {
  jobs = new Map<string, DownloadJob>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private bcastTimer: ReturnType<typeof setTimeout> | null = null
  private lastBcast = 0
  private listeners: Array<() => void> = []

  async restore() {
    try {
      const { jobs } = await chrome.storage.local.get('jobs')
      if (Array.isArray(jobs)) {
        for (const j of jobs as DownloadJob[]) this.jobs.set(j.id, j)
      }
    } catch {
      /* ignore */
    }
  }

  create(job: DownloadJob) {
    this.jobs.set(job.id, job)
    this.persist()
    this.broadcast(true)
    this.notify()
  }

  /** offscreen 上报进度；SW 若被回收导致内存丢失，则按上报内容重建骨架 */
  update(jobId: string, patch: Partial<DownloadJob>) {
    let job = this.jobs.get(jobId)
    if (!job) {
      job = {
        id: jobId,
        tabId: patch.tabId ?? -1,
        pageUrl: patch.pageUrl ?? '',
        title: patch.title ?? '视频',
        url: patch.url ?? '',
        mediaUrl: patch.mediaUrl ?? patch.url ?? '',
        status: 'downloading',
        totalSegments: 0,
        doneSegments: 0,
        totalBytes: 0,
        doneBytes: 0,
        startedAt: Date.now(),
        ...patch,
      }
      this.jobs.set(jobId, job)
    } else {
      Object.assign(job, patch)
    }
    this.persist()
    this.broadcast()
    this.notify()
  }

  list(): DownloadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  hasActive(): boolean {
    for (const j of this.jobs.values()) if (isActive(j)) return true
    return false
  }

  onChanged(fn: () => void) {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn)
    }
  }

  private notify() {
    for (const fn of this.listeners) fn()
  }

  private persist() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const arr = this.list().slice(0, MAX_JOBS)
      chrome.storage.local.set({ jobs: arr }).catch(() => {})
    }, 500)
  }

  /** 广播给 popup（节流 400ms，每个分片完成都会触发一次更新） */
  broadcast(force = false) {
    const send = () => {
      this.lastBcast = Date.now()
      chrome.runtime.sendMessage({ target: 'popup', type: 'JOBS_UPDATED', jobs: this.list() }).catch(() => {})
    }
    if (force) {
      send()
      return
    }
    const wait = Math.max(0, 400 - (Date.now() - this.lastBcast))
    if (wait === 0) send()
    else {
      clearTimeout(this.bcastTimer!)
      this.bcastTimer = setTimeout(send, wait)
    }
  }
}

export const jobManager = new JobManager()
