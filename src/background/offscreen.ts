const OFFSCREEN_URL = 'src/offscreen/index.html'

async function hasOffscreen(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    })
    return contexts.length > 0
  } catch {
    return false
  }
}

/** 确保 offscreen document 存在（全扩展仅允许一个实例） */
export async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: '下载视频分片、解密、合并并保存文件',
    })
  } catch (e: any) {
    // 并发创建时会报 "Only a single offscreen document" — 忽略
    if (!String(e?.message ?? e).includes('single offscreen')) throw e
  }
}
