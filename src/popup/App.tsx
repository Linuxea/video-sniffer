import { useCallback, useEffect, useRef, useState } from 'react'
import {
  formatBytes,
  formatDuration,
  hostOf,
  type DownloadJob,
  type JobStatus,
  type MediaResource,
  type PlaylistInfo,
} from '../shared/types'

type InspectState = { loading: true } | { error: string } | { info: PlaylistInfo }

const ACTIVE: JobStatus[] = ['preparing', 'downloading', 'muxing', 'saving']

const STATUS_TEXT: Record<JobStatus, string> = {
  preparing: '准备中…',
  downloading: '下载中',
  muxing: '合并转封装中…',
  saving: '保存中…',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
}

function send<T = any>(msg: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(msg)
}

// ---------------------------------------------------------------- 子组件

function ExtBadge({ res }: { res: MediaResource }) {
  const label = (res.ext || res.kind).toUpperCase()
  const color =
    res.kind === 'hls'
      ? { background: 'rgba(245,158,11,.15)', color: '#fbbf24' }
      : res.kind === 'dash'
        ? { background: 'rgba(96,165,250,.15)', color: '#60a5fa' }
        : res.kind === 'segment'
          ? { background: 'rgba(139,144,160,.15)', color: '#8b90a0' }
          : { background: 'rgba(52,211,153,.15)', color: '#34d399' }
  return (
    <span className="ext-badge" style={color}>
      {label}
    </span>
  )
}

function ResourceMeta({ res }: { res: MediaResource }) {
  const bits: string[] = []
  // 清单文件本身的大小（几 KB 级）没有参考意义，容易被误读成视频大小，不展示
  const size = formatBytes(res.sizeBytes)
  if (size && res.kind !== 'hls' && res.kind !== 'dash') bits.push(size)
  const dur = formatDuration(res.duration)
  if (dur) bits.push(dur)
  if (res.width && res.height) bits.push(`${res.width}×${res.height}`)
  bits.push(hostOf(res.url))
  const t = new Date(res.capturedAt)
  bits.push(`发现于 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`)
  return (
    <div className="res-meta">
      {bits.map((b, i) => (
        <span key={i}>
          {i > 0 && <span className="sep">·</span>}
          {b}
        </span>
      ))}
    </div>
  )
}

function JobCard({
  job,
  onCancel,
  onRemove,
}: {
  job: DownloadJob
  onCancel: (id: string) => void
  onRemove: (id: string) => void
}) {
  const pct =
    job.totalBytes > 0
      ? Math.min(100, (job.doneBytes / job.totalBytes) * 100)
      : job.totalSegments > 0
        ? (job.doneSegments / job.totalSegments) * 100
        : 0
  const cls = job.status === 'done' ? 'ok' : job.status === 'error' || job.status === 'canceled' ? 'bad' : 'busy'
  const right = ACTIVE.includes(job.status) ? (
    <button className="mini-btn" onClick={() => onCancel(job.id)} title="取消">
      取消
    </button>
  ) : (
    <button className="mini-btn" onClick={() => onRemove(job.id)} title="删除记录">
      ✕
    </button>
  )
  return (
    <div className="job">
      <div className="job-head">
        <div className="job-title" title={job.filename || job.title}>
          {job.variantLabel ? `${job.title} [${job.variantLabel}]` : job.title}
        </div>
        <span className={`job-status ${cls}`}>{STATUS_TEXT[job.status]}</span>
        {right}
      </div>
      {job.status !== 'error' && job.status !== 'canceled' && (
        <>
          <div className="bar">
            <div style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
          <div className="job-meta">
            <span>
              {job.totalSegments > 0 ? `分片 ${job.doneSegments}/${job.totalSegments}` : ''}
              {job.totalBytes > 0 ? ` · ${formatBytes(job.doneBytes)}` : ''}
            </span>
            <span>{pct > 0 ? `${pct.toFixed(0)}%` : ''}</span>
          </div>
        </>
      )}
      {job.error && (
        <div className="job-meta">
          <span className="err" title={job.error}>
            {job.error}
          </span>
        </div>
      )}
      {job.status === 'done' && job.filename && (
        <div className="job-meta">
          <span title={job.filename}>已保存: {job.filename.split('/').pop()}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 主组件

export default function App() {
  const [tabId, setTabId] = useState<number | null>(null)
  const [resources, setResources] = useState<MediaResource[]>([])
  const [jobs, setJobs] = useState<DownloadJob[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [inspects, setInspects] = useState<Record<string, InspectState>>({})
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((text: string, err = false) => {
    setToast({ text, err })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }, [])

  const refreshResources = useCallback(async (tid: number) => {
    try {
      const resp = await send({ target: 'background', type: 'GET_RESOURCES', tabId: tid })
      if (resp?.ok) setResources(resp.resources ?? [])
    } catch {
      /* ignore */
    }
  }, [])

  const refreshJobs = useCallback(async () => {
    try {
      const resp = await send({ target: 'background', type: 'GET_JOBS' })
      if (resp?.ok) setJobs(resp.jobs ?? [])
    } catch {
      /* ignore */
    }
  }, [])

  // 初始化
  useEffect(() => {
    ;(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return
      setTabId(tab.id)
      await refreshResources(tab.id)
      await refreshJobs()
    })()
  }, [refreshResources, refreshJobs])

  // 订阅 background 广播
  useEffect(() => {
    const listener = (msg: any) => {
      if (!msg || msg.target !== 'popup') return
      if (msg.type === 'RESOURCES_UPDATED' && typeof msg.tabId === 'number') {
        if (tabId !== null && msg.tabId === tabId) setResources(msg.resources ?? [])
      } else if (msg.type === 'JOBS_UPDATED') {
        setJobs(msg.jobs ?? [])
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [tabId])

  // ---------------------------------------------------------------- actions

  const inspect = useCallback(
    async (res: MediaResource) => {
      if (tabId == null) return
      setInspects((s) => ({ ...s, [res.id]: { loading: true } }))
      try {
        const resp = await send({ target: 'background', type: 'INSPECT_HLS', id: res.id, tabId })
        if (resp?.ok) setInspects((s) => ({ ...s, [res.id]: { info: resp.info } }))
        else setInspects((s) => ({ ...s, [res.id]: { error: resp?.error ?? '解析失败' } }))
      } catch (e: any) {
        setInspects((s) => ({ ...s, [res.id]: { error: e?.message ?? String(e) } }))
      }
    },
    [tabId],
  )

  const toggle = useCallback(
    (res: MediaResource) => {
      setOpenId((cur) => {
        const next = cur === res.id ? null : res.id
        if (next !== null && res.kind === 'hls' && !inspects[res.id]) void inspect(res)
        return next
      })
    },
    [inspects, inspect],
  )

  const copyUrl = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url)
        showToast('地址已复制')
      } catch {
        showToast('复制失败', true)
      }
    },
    [showToast],
  )

  const startDirect = useCallback(
    async (res: MediaResource) => {
      if (tabId == null) return
      try {
        const resp = await send({ target: 'background', type: 'START_DIRECT', id: res.id, tabId })
        if (resp?.ok) showToast('已开始下载，见浏览器下载')
        else showToast(resp?.error ?? '下载失败', true)
      } catch (e: any) {
        showToast(e?.message ?? String(e), true)
      }
    },
    [tabId, showToast],
  )

  const startHls = useCallback(
    async (res: MediaResource, variantUrl?: string, variantLabel?: string) => {
      if (tabId == null) return
      try {
        const resp = await send({
          target: 'background',
          type: 'START_HLS',
          id: res.id,
          tabId,
          variantUrl,
          variantLabel,
        })
        if (resp?.ok) {
          showToast('任务已创建')
          await refreshJobs()
        } else {
          showToast(resp?.error ?? '创建任务失败', true)
        }
      } catch (e: any) {
        showToast(e?.message ?? String(e), true)
      }
    },
    [tabId, showToast, refreshJobs],
  )

  const cancelJob = useCallback(
    (jobId: string) => {
      void send({ target: 'background', type: 'CANCEL_JOB', jobId }).then(refreshJobs)
    },
    [refreshJobs],
  )

  const removeJob = useCallback(
    (jobId: string) => {
      void send({ target: 'background', type: 'REMOVE_JOB', jobId }).then(refreshJobs)
    },
    [refreshJobs],
  )

  const clearFinishedJobs = useCallback(async () => {
    await send({ target: 'background', type: 'CLEAR_FINISHED_JOBS' }).catch(() => {})
    await refreshJobs()
  }, [refreshJobs])

  const rescan = useCallback(async () => {
    if (tabId == null) return
    await send({ target: 'background', type: 'RESCAN', tabId }).catch(() => {})
    setTimeout(() => refreshResources(tabId), 600)
  }, [tabId, refreshResources])

  const clearAll = useCallback(async () => {
    if (tabId == null) return
    await send({ target: 'background', type: 'CLEAR_RESOURCES', tabId }).catch(() => {})
    setResources([])
    setInspects({})
    setOpenId(null)
  }, [tabId])

  // ---------------------------------------------------------------- render

  const activeJobs = jobs.filter((j) => ACTIVE.includes(j.status))
  const doneJobs = jobs.filter((j) => !ACTIVE.includes(j.status)).slice(0, 5)

  return (
    <>
      <div className="header">
        <div className="logo">▶</div>
        <h1>视频嗅探器</h1>
        <span className="count">{resources.length}</span>
        <button className="icon-btn" title="重新扫描页面" onClick={rescan}>
          ⟳
        </button>
        <button className="icon-btn" title="清空列表" onClick={clearAll}>
          🗑
        </button>
        <button className="icon-btn" title="设置" onClick={() => chrome.runtime.openOptionsPage()}>
          ⚙
        </button>
      </div>

      <div className="list">
        {(activeJobs.length > 0 || doneJobs.length > 0) && (
          <>
            <div className="section-title">
              <span>下载任务{activeJobs.length > 0 ? ` · ${activeJobs.length} 进行中` : ''}</span>
              {doneJobs.length > 0 && (
                <button className="mini-btn" style={{ marginLeft: 'auto' }} onClick={clearFinishedJobs}>
                  清空记录
                </button>
              )}
            </div>
            {activeJobs.map((j) => (
              <JobCard key={j.id} job={j} onCancel={cancelJob} onRemove={removeJob} />
            ))}
            {doneJobs.map((j) => (
              <JobCard key={j.id} job={j} onCancel={cancelJob} onRemove={removeJob} />
            ))}
          </>
        )}

        <div className="section-title">发现的资源</div>
        {resources.length === 0 && (
          <div className="empty">
            <span className="big">🔍</span>
            还没发现视频资源。
            <br />
            试着在页面里<b>播放视频</b>，或点右上角 ⟳ 重新扫描。
          </div>
        )}
        {resources.map((res) => {
          const open = openId === res.id
          const insp = inspects[res.id]
          return (
            <div key={res.id} className={`res${open ? ' open' : ''}`}>
              <div className="res-row" onClick={() => toggle(res)}>
                <ExtBadge res={res} />
                <div className="res-main">
                  <div className="res-name">{nameFor(res)}</div>
                  <ResourceMeta res={res} />
                </div>
                <span className="chev">▶</span>
              </div>

              {open && (
                <div className="detail">
                  <div className="url-box">
                    <div className="url">{res.url}</div>
                    <button className="mini-btn" onClick={() => copyUrl(res.url)}>
                      复制
                    </button>
                  </div>

                  {/* 直链文件 */}
                  {res.kind === 'direct' && (
                    <div className="actions">
                      <button className="btn primary" onClick={() => startDirect(res)}>
                        ⬇ 下载（{res.ext.toUpperCase() || '视频'}）
                      </button>
                    </div>
                  )}

                  {/* HLS */}
                  {res.kind === 'hls' && (
                    <>
                      {!insp && <div className="loading">解析中…</div>}
                      {insp && 'loading' in insp && <div className="loading">解析 m3u8 中…</div>}
                      {insp && 'error' in insp && <div className="error-text">{insp.error}</div>}
                      {insp && 'info' in insp && insp.info.type === 'media' && (
                        <div className="actions">
                          <div className="hint">
                            {insp.info.segmentCount} 个分片 · 时长约 {formatDuration(insp.info.totalDuration)}
                            {insp.info.encrypted && ' · AES-128 加密（将自动解密）'}
                          </div>
                          <button className="btn primary" onClick={() => startHls(res)}>
                            ⬇ 下载并合并为 MP4
                          </button>
                        </div>
                      )}
                      {insp && 'info' in insp && insp.info.type === 'master' && (
                        <div className="variants">
                          <div className="hint" style={{ marginTop: 0 }}>
                            检测到 {insp.info.variants.length} 个清晰度，选择一个下载：
                          </div>
                          {insp.info.variants.map((v) => (
                            <div className="variant" key={v.url}>
                              <div>
                                <div className="v-label">{variantLabel(v)}</div>
                                {v.codecs && <div className="v-sub">{v.codecs}</div>}
                              </div>
                              <button className="mini-btn" onClick={() => startHls(res, v.url, variantLabel(v))}>
                                下载
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* 其他类型提示 */}
                  {res.kind === 'blob' && (
                    <div className="hint">
                      MSE 流媒体（blob 地址无法直接下载）。播放视频后，网络层通常会捕获到真实的 m3u8 地址。
                    </div>
                  )}
                  {res.kind === 'dash' && (
                    <div className="hint">DASH 流暂不支持内置下载，可复制地址使用外部工具（如 N_m3u8DL）。</div>
                  )}
                  {res.kind === 'segment' && (
                    <div className="hint">疑似视频分片。请寻找列表中的 m3u8 清单条目下载完整视频。</div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="footer">仅供合法用途 · 不支持 DRM 保护内容</div>
      {toast && <div className={`toast${toast.err ? ' err' : ''}`}>{toast.text}</div>}
    </>
  )
}

function nameFor(res: MediaResource): string {
  try {
    const u = new URL(res.url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (last && /\.(mp4|webm|flv|mov|mkv|m3u8|mpd|ts|m4s)/i.test(last)) {
      return decodeURIComponent(last).slice(0, 60)
    }
    if (last) return decodeURIComponent(last).slice(0, 48)
    return u.hostname
  } catch {
    return res.url.slice(0, 48)
  }
}

function variantLabel(v: { resolution?: string; bandwidth?: number; name?: string }): string {
  if (v.resolution) return v.resolution
  if (v.name) return v.name
  if (v.bandwidth) {
    const mbps = v.bandwidth / 1_000_000
    return mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${Math.round(v.bandwidth / 1000)} kbps`
  }
  return '默认'
}
