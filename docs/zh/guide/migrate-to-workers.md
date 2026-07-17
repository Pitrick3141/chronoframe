# 迁移现有安装

当前**没有**从旧版 SQLite/S3/本地文件系统/OpenList 部署自动迁移的命令。请将此次升级作为受控数据迁移，在验证完成前保持旧站点只读。

## 1. 盘点并冻结旧站点

1. 记录 ChronoFrame 的准确版本和 storage provider。
2. 停止旧站点的上传、编辑、相册变更和 reaction 写入。
3. 备份 SQLite。Docker 安装通常通过 `/app/data` volume 使用 `./data/app.sqlite3`，但应以实际 `DATABASE_URL` 为准。
4. 导出完整对象清单，至少包含 key、大小、content type，以及存储服务可提供的 checksum。
5. 统计用户、照片、相册、相册关系、reaction、设置和待处理任务数量。

SQLite 备份示例：

```bash
mkdir -p backup
sqlite3 ./data/app.sqlite3 ".backup './backup/app.sqlite3'"
sqlite3 ./backup/app.sqlite3 "PRAGMA integrity_check;"
```

还要独立备份底层 S3、本地或 OpenList 对象；只有数据库文件并不是完整画廊备份。

## 2. 创建空的 Workers 部署

按照 [部署到 Cloudflare Workers](/zh/guide/getting-started) 创建 D1 与 R2、启用 Hosted Images 与 Stream，并核对五个 bindings。导入记录前先应用仓库中的 migrations：

```bash
pnpm d1:migrate:remote
```

此时不要把生产流量切到新 Worker。

## 3. 转换关系数据

应按表导出并转换数据，不要把未经检查的 SQLite `.dump` 直接应用到 D1。旧 dump 可能包含本地 transaction、`PRAGMA`、SQLite 内部表，以及与 D1 migrations 冲突的 schema 定义。

建议导入顺序：

1. `users`
2. 删除旧存储凭据后再导入 `settings` 与 `settings_storage_providers`
3. `photos`
4. `albums`
5. `album_photos`
6. `photo_reactions`

不要把陈旧的 `pipeline_queue` 记录当作可运行任务导入；应明确核对或丢弃。迁移时保留主键和时间戳，校验 JSON 列，并将旧日期/布尔表示转换为当前 D1 schema 的格式。

检查生成的 SQL 后再用 Wrangler 导入：

```bash
pnpm exec wrangler d1 execute DB --remote --file=./migration/import.sql
```

当前仓库提供目标 schema 和 migrations，但不会自动生成 `migration/import.sql`。

## 4. 将图片二进制迁移到 Hosted Images

对每一张旧照片执行：

1. 通过 `storage_key` 找到原始二进制并确认它确实是图片。
2. 上传前转换不受支持的输入；目标图片必须满足 Hosted Images 的 10 MiB、格式和尺寸限制。
3. 如果需要不可逆地删除位置数据，必须在上传前清除二进制中的 EXIF/GPS；只清理 D1 字段不会重写 Hosted Image 原图。
4. 通过 Cloudflare Images API 或经过审查的一次性 Worker 使用 `IMAGES` Hosted Images binding 上传。
5. 让 Hosted Images 自动生成图片 ID，并把返回的 ID 写入 `cloudflare_image_id`。不要使用自定义 ID：ChronoFrame 强制 `requireSignedURLs: true`，自定义 ID 与该私有图片策略不兼容。
6. 更新照片的源文件名、MIME、大小、图片 ID 和 Worker 交付 URL。
7. 不要迁移旧版生成的缩略图文件；Worker 会通过 Images binding 动态生成 WebP 缩略图。

请维护迁移 manifest，记录旧 key、photo ID、目标 Hosted Image ID、源大小、checksum 与迁移状态。所有重试都从 manifest 驱动，以保证幂等。

## 5. 将所有视频迁移到 Cloudflare Stream

所有旧视频都必须迁移到 Stream，包括以前与图片一起存储的 Live/Motion Photo MOV/MP4 伴侣。不要把视频二进制复制到 R2。

对每个视频执行：

1. 通过旧 key 找到原始二进制，并在 manifest 中保留文件名、MIME、大小、关联 photo ID、时长和 checksum。
2. 确认符合当前上传约束：basic POST Direct Creator Upload 要求文件小于 200 MB；ChronoFrame 默认限制为 `199999999` 字节，且 `maxDurationSeconds: 600`。超限文件需先转换或拆分；这里没有实现 tus 迁移。
3. 使用经过审查的导入器或已部署的 ChronoFrame 上传端点，以 `requireSignedURLs: true` 调用 `STREAM.createDirectUpload()`，再把 multipart 视频 POST 到返回的一次性 URL。
4. 保存返回的 Stream ID，轮询到处理完成，并通过 ChronoFrame 验证签名 HLS manifest 可以播放。
5. 将 `cloudflare_stream_id` 与 `live_photo_video_key` 设为同一个 Stream ID，将 `live_photo_video_url` 设为 `/media/streams/<URL 编码后的 photo ID>/manifest.m3u8`，将 `stream_status` 设为 `ready`；除非实现独立的鉴权 DASH 路由，否则 `stream_dash_url` 保持 null。缩略图、时长等非播放元数据可以从 Stream 写入。
6. 按原始 basename 将 Live/Motion Photo 视频与图片匹配，并逐组验证。

Worker 获得公开 HTTPS 地址后，配置账户级 Stream webhook。API 响应中会
返回签名 secret；请把 `result.secret` 原样写入 Worker secret：

调用此 API 的 Cloudflare Token 必须具有 Stream Edit 权限；可以使用独立的短期配置 Token，无需与 CI 部署 Token 共用。

```bash
curl --request PUT \
  --url "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/stream/webhook" \
  --header "Authorization: Bearer <API_TOKEN>" \
  --header "Content-Type: application/json" \
  --data '{"notificationUrl":"https://<CHRONOFRAME_HOST>/api/webhooks/cloudflare-stream"}'

pnpm exec wrangler secret put CFRAME_STREAM_WEBHOOK_SECRET
```

每个 Cloudflare 账户只能配置一个 Stream webhook。更新订阅会替换通知
地址/secret，因此必须同时更新 Worker secret。ChronoFrame 只有在原始 body
HMAC 验签通过且时间戳位于五分钟窗口内时才会修改 D1；有效的终态通知会
关闭匹配的持久化队列任务，即使上传页面已经关闭也不受影响。

ChronoFrame 不会自动把旧的公开 Stream 资源改为私有。若资源创建时使用了 `requireSignedURLs: false`，即使 D1 已改为同源路由，知道原 Cloudflare URL 的人仍可直接播放。请重新上传为签名资源，或通过经过审查的迁移显式将该 Stream 资源改为要求签名 URL；确认无签名直连已经失败后，再从迁移 manifest 中移除旧 URL。

Stream 按存储分钟和传输分钟计费。迁移容量规划应包含源视频总时长与预计播放量；待使用的 Direct Creator URL 会临时按配置的最大时长预留容量。

## 6. 将其他对象迁移到 R2

只有既非图片也非视频的对象才能进入 `chronoframe-media`。应通过仅管理员可用的 [`/api/objects` 目录流程](/zh/development/api) 导入：先创建 intent，再向其生成的 `/upload` 端点上传完全匹配的字节数，最后在 R2 确认对象后 finalize。目录会分配不透明的 `objects/catalog/<uuid>` key，并把权威大小、ETag 与版本元数据写入 D1。

不要对应用管理的对象直接使用 `wrangler r2 object put`，否则会绕过媒体分类、只创建不覆盖保护以及权威 D1 目录。经过审查的批量导入器也必须复现相同的 key、校验与 finalize 约束。不得把图片或视频二进制上传到 R2。

## 7. 切流量前验证

- 比较每张表迁移前后的行数。
- 将迁移 manifest 与 Hosted Images、Stream 视频和 R2 对象数量逐项核对。
- 至少抽查每种源格式各一张，以及多张大图和旋转图。
- 验证 `/media/images/:id` 与 `/media/images/:id/thumbnail` 两种交付。
- 抽查多种 MOV/MP4 的 Stream 处理状态与 HLS 播放。
- 验证相册、reaction、地图坐标、登录、删除，以及一组由 Stream 承载的 Live Photo。
- 明确记录所有失败和超限文件，不能静默遗漏。
- 检查期间让新站点保持只读，确认无误后再切换 DNS/route 流量。

请保留冻结的源数据库和对象备份，直到新部署经过实际使用并建立 D1/Images/Stream/R2 备份与清单策略。
