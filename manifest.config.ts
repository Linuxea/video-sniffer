import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: '视频嗅探器 Video Sniffer',
  short_name: 'VideoSniffer',
  description:
    '嗅探网页中的视频资源（MP4 / HLS / FLV / WebM 等），支持 m3u8 分片下载、AES-128 解密并合并为 MP4',
  version: '0.1.0',
  minimum_chrome_version: '116',
  icons: {
    '16': 'icons/icon-16.png',
    '32': 'icons/icon-32.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: '视频嗅探器',
    default_icon: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
  },
  permissions: ['webRequest', 'downloads', 'storage', 'offscreen', 'alarms'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: true,
    },
  ],
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: false,
  },
})
