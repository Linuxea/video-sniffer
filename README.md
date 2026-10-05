# 视频嗅探器 Video Sniffer

一款 Chrome (Manifest V3) 扩展：自动嗅探网页中的视频资源，提供一键下载。支持 HLS (m3u8) 分片下载、AES-128 自动解密、TS→MP4 转封装合并。

## 功能

- **三层嗅探**
  - 网络层：`webRequest` 观察模式捕获 `mp4 / webm / flv / m3u8 / mpd / ts / m4s` 等请求（含 MSE 流媒体的真实地址）
  - DOM 层：扫描 `video / source / embed / object`，补充时长、分辨率元信息
  - 兜底层：performance resource entries（捕获 content script 注入前的请求）
- **直链下载**：mp4/webm/flv 等直接调用浏览器下载
- **HLS 完整下载**：解析 master playlist 多清晰度任选 → 并发分片下载 → AES-128 自动解密 → 合并为 MP4（fMP4 流直接拼接；TS 流经 mux.js 转封装，失败回退 `.ts`）
- **防盗链兼容**：offscreen 直连失败时，自动经 content script 在页面上下文中转 fetch（带 Cookie / Referer）
- 下载在后台进行，**关闭 popup 不中断**

## 开发

```bash
npm install
npm run icons   # 生成扩展图标（仅需一次）
npm run build   # 产物输出到 dist/
npm run watch   # 增量构建
npm run check   # TypeScript 类型检查
```

## 安装（加载未打包扩展）

1. `npm install && npm run icons && npm run build`
2. 打开 `chrome://extensions`，右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本项目的 `dist/` 目录

## 使用

1. 打开有视频的网页并**播放视频**（很多站播放时才请求真实地址）
2. 点扩展图标查看嗅探到的资源列表
3. MP4 等直链 → 直接点下载；m3u8 → 展开选择清晰度后下载合并
4. 任务进度在 popup 顶部「下载任务」区展示

## 测试素材

- 直链 MP4: <https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4>
- HLS: <https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8>（多清晰度）
- AES-128: <https://test-streams.mux.dev/pts_shift/master.m3u8>（参考，需自行验证）

## 已知限制

- 不支持 YouTube（私有格式 + 签名混淆 + ToS 风险）
- 不支持 DRM（Widevine/FairPlay）内容，检测到 SAMPLE-AES 等会明确报错
- 直播流（无 `EXT-X-ENDLIST`）暂不支持
- 超大视频（> 2GB）在内存中合并，可能占用较多内存
- DASH (mpd) 仅检测展示，暂不支持内置下载

## 权限说明

| 权限 | 用途 |
|------|------|
| `webRequest` + `<all_urls>` | 观察所有站点的媒体请求（不阻塞、不修改） |
| `downloads` | 直链文件下载、文件命名 |
| `storage` | 嗅探结果（session）与任务进度（local）持久化 |
| `offscreen` | 后台分片下载/解密/合并 |
| `alarms` | 下载期间保活 service worker |

## 免责声明

仅供个人学习与合法内容备份。请遵守所在地区法律及目标网站的服务条款，勿用于下载受版权保护或 DRM 保护的内容。
