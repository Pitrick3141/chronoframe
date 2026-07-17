# Cloudflare 存储绑定

Workers 版 ChronoFrame 使用固定的存储架构。存储通过 `wrangler.jsonc` 中的 Cloudflare bindings 配置，不再从控制台选择 S3、本地文件系统或 OpenList provider。

## 存储映射

| 数据                     | 服务                            | 绑定           |
| ------------------------ | ------------------------------- | -------------- |
| 应用状态与照片元数据     | D1                              | `DB`           |
| 所有图片二进制           | Cloudflare Images Hosted Images | `IMAGES`       |
| 所有视频二进制与播放     | Cloudflare Stream               | `STREAM`       |
| 其他非图片、非视频对象   | R2                              | `MEDIA_BUCKET` |
| 构建后的 Nuxt 客户端文件 | Workers Assets                  | `ASSETS`       |

绑定名属于应用接口的一部分。如果资源名称发生变化，只修改 `wrangler.jsonc` 中绑定指向的目标，不要修改绑定名。

## D1

创建数据库，并把返回的 UUID 填入 `wrangler.jsonc`：

```bash
pnpm d1:create
pnpm d1:migrate:remote
```

D1 只保存记录，不保存图片或视频正文。升级 schema 或批量导入前请先备份。

## Cloudflare Images Hosted Images

Hosted Images 需要启用 [付费存储计划](https://developers.cloudflare.com/images/pricing/)。Worker 通过 `IMAGES` 绑定上传、检查、交付和删除图片，无需在应用设置中保存 Images API Token。

应用不要求账户级交付变体。`/media/images/:id` 先按 D1 校验可见性，再返回最长边不超过 4096 px、已剥离元数据的 WebP 展示图；`/media/images/:id/thumbnail` 返回 600 px WebP 缩略图。Hosted Image 原始字节仅管理员可通过 `/media/images/:id/source` 获取。不要为 ChronoFrame 媒体创建始终公开的变体，否则直连交付会绕过隐藏相册鉴权。

Hosted Images **每个已存图片最多 10 MiB**。ChronoFrame 可接收最多 **25 MiB** 的复合 JPEG Motion Photo，但会在存储前完成拆分：静态 JPEG（仍不得超过 10 MiB）进入 Hosted Images，经校验的内嵌 MP4 进入 Stream。输入格式支持 JPEG、PNG、GIF、WebP、SVG 与 HEIC，AVIF 输入仅限 Enterprise。图片尺寸、总像素数和动画图片另有限制，请查看最新的 [Images 限制](https://developers.cloudflare.com/images/get-started/limits/)。

超过限制或格式不兼容的图片必须在上传前转换或缩小。非图片文件不能上传到 `IMAGES`。

## Cloudflare Stream

所有受支持的视频（包括 Live/Motion Photo 伴侣）均由 Stream 存储和传输。`STREAM` binding 创建一次性的 [Direct Creator Upload](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/) URL，浏览器再将 multipart 正文直接发送到 Cloudflare，不会获得 API Token。处理完成后，ChronoFrame 使用 Stream 的 HLS manifest 播放。

Binding 当前创建 basic POST 上传。Cloudflare 要求这类文件**小于 200 MB**，因此 ChronoFrame 默认限制为 **199999999 字节**。达到或超过 200 MB 的文件必须使用 tus，而当前上传流程没有实现 tus。`NUXT_CLOUDFLARE_STREAM_MAX_DURATION_SECONDS` 默认为 **600**。

Stream 按[存储分钟和传输分钟](https://developers.cloudflare.com/stream/pricing/)计费，而不是按 R2 bytes 或出口流量计费。Direct Creator Upload 在完成、过期或失败前会按 `maxDurationSeconds` 预留存储容量；完成后按视频实际时长占用。

Worker 通过 `STREAM` binding 操作视频时不需要 Stream API Token，API 凭据不会进入应用代码或浏览器。但仍必须配置 Cloudflare 订阅响应返回的 `CFRAME_STREAM_WEBHOOK_SECRET`，用于校验视频处理通知。

## R2

创建 `wrangler.jsonc` 中声明的存储桶：

```bash
pnpm exec wrangler r2 bucket create chronoframe-media
```

应用通过 `MEDIA_BUCKET` 绑定访问 R2，因此不需要 S3 access key、endpoint、公开存储桶或浏览器直传 CORS。仅限管理员的 `/api/objects` 流程会把对象生命周期元数据保存到 D1，在 finalize 时核对 R2 对象，并通过受控的 Worker 路由下载，而不是公开 R2 域名。

R2 严格只保存既非图片也非视频的对象。图片进入 Hosted Images，所有视频进入 Stream。

## 本地开发

Wrangler 会提供 D1、R2 与 Hosted Images 的本地绑定实现：

```bash
pnpm d1:migrate:local
pnpm dev:worker
```

本地 D1/R2/Images 数据与生产隔离。Stream Direct Creator Upload 与 HLS 播放应在连接账号的预览部署中测试。日常开发不要使用远端资源，除非确实要修改它们。

## 旧存储 Provider

S3 兼容存储、本地文件系统与 OpenList 属于上一代 Node/Docker 架构，不再是 Workers 版本可选择的 provider。现有图片必须迁移到 Hosted Images、视频迁移到 Stream、其余对象迁移到 R2，且需要明确、可验证的迁移流程，详见 [迁移现有安装](/zh/guide/migrate-to-workers)。
