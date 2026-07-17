# 配置项说明

Cloudflare 资源在 `wrangler.jsonc` 中配置为 bindings。运行时 secret 使用 `wrangler secret put` 保存；非敏感 Nuxt 值可配置为 Worker variables 或构建环境变量。

## 必需绑定与 Secret

| 名称                           | 类型                   | 必需 | 用途                                                                     |
| ------------------------------ | ---------------------- | ---- | ------------------------------------------------------------------------ |
| `DB`                           | D1 binding             | 是   | 关系数据                                                                 |
| `IMAGES`                       | Images binding         | 是   | Hosted Images                                                            |
| `STREAM`                       | Stream binding         | 是   | 所有视频的存储、处理与 HLS 传输                                          |
| `MEDIA_BUCKET`                 | R2 binding             | 是   | 其他非图片、非视频对象                                                   |
| `ASSETS`                       | Workers Assets binding | 是   | Nuxt 客户端资源                                                          |
| `NUXT_SESSION_PASSWORD`        | Worker secret          | 是   | 会话加密，至少 32 个随机字符                                             |
| `CFRAME_BOOTSTRAP_TOKEN`       | Worker secret          | 是   | 为首次初始化向导鉴权，至少 32 个随机字符                                 |
| `CFRAME_STREAM_WEBHOOK_SECRET` | Worker secret          | 是   | 校验 Stream `Webhook-Signature`；必须使用订阅 API 返回的 `result.secret` |

使用 `pnpm exec wrangler secret put <NAME>` 设置 secret。session/bootstrap 值应独立生成；Stream webhook secret 必须原样复制 Cloudflare 返回值。不要提交 secret，也不要把它们写入 `wrangler.jsonc`。

## 应用变量

| 变量                                   | 说明                            | 默认值                                |
| -------------------------------------- | ------------------------------- | ------------------------------------- |
| `NUXT_PUBLIC_APP_TITLE`                | 站点标题                        | `ChronoFrame`                         |
| `NUXT_PUBLIC_APP_SLOGAN`               | 站点口号                        | 空                                    |
| `NUXT_PUBLIC_APP_AUTHOR`               | 站点作者                        | 空                                    |
| `NUXT_PUBLIC_APP_AVATAR_URL`           | 站点头像 URL                    | 空                                    |
| `NUXT_PUBLIC_MAP_PROVIDER`             | `mapbox` 或 `maplibre`          | `maplibre`                            |
| `NUXT_PUBLIC_MAP_MAPLIBRE_STYLE`       | MapLibre style URL              | 空                                    |
| `NUXT_PUBLIC_MAP_MAPBOX_STYLE`         | Mapbox style URL                | 空                                    |
| `NUXT_PUBLIC_MAPBOX_ACCESS_TOKEN`      | 浏览器可用的 Mapbox token       | 空                                    |
| `NUXT_MAPBOX_ACCESS_TOKEN`             | 服务端 Mapbox token             | 空                                    |
| `NUXT_NOMINATIM_BASE_URL`              | 逆地理编码 API 基础 URL         | `https://nominatim.openstreetmap.org` |
| `NUXT_PUBLIC_OAUTH_GITHUB_ENABLED`     | 启用 GitHub OAuth               | `false`                               |
| `NUXT_OAUTH_GITHUB_CLIENT_ID`          | GitHub OAuth client ID          | 空                                    |
| `NUXT_OAUTH_GITHUB_CLIENT_SECRET`      | GitHub OAuth client secret      | 空                                    |
| `NUXT_PUBLIC_GTAG_ID`                  | Google Analytics measurement ID | 空                                    |
| `NUXT_PUBLIC_ANALYTICS_MATOMO_ENABLED` | 启用 Matomo                     | `false`                               |
| `NUXT_PUBLIC_ANALYTICS_MATOMO_URL`     | Matomo URL                      | 空                                    |
| `NUXT_PUBLIC_ANALYTICS_MATOMO_SITE_ID` | Matomo site ID                  | 空                                    |

管理员密码只在初始化向导中提交，并以密码哈希保存到 D1；它不是 Wrangler secret。服务端地图 token、OAuth client secret 与其他仅服务端使用的凭据即使可选，也应保存为 Worker secrets。

## 上传配置

| 变量                                             | 说明                                     | 默认值                         |
| ------------------------------------------------ | ---------------------------------------- | ------------------------------ |
| `NUXT_PUBLIC_CLOUDFLARE_IMAGES_MAX_UPLOAD_BYTES` | Hosted Images 的 UI 限制                 | `10485760`（10 MiB）           |
| `NUXT_PUBLIC_CLOUDFLARE_STREAM_MAX_UPLOAD_BYTES` | Stream 视频上传的应用限制                | `199999999`（严格小于 200 MB） |
| `NUXT_CLOUDFLARE_STREAM_MAX_DURATION_SECONDS`    | Direct Creator Upload 预留的最大视频时长 | `600`                          |
| `NUXT_PUBLIC_CLOUDFLARE_R2_MAX_OBJECT_BYTES`     | 经 Worker 传输的 R2 原始上传应用限制     | `100000000`（100 MB）          |
| `NUXT_UPLOAD_MIME_WHITELIST_ENABLED`             | 校验上传 MIME                            | `true`                         |
| `NUXT_UPLOAD_MIME_WHITELIST`                     | 允许的 MIME，逗号分隔                    | 见下方                         |

默认白名单：

```dotenv
NUXT_UPLOAD_MIME_WHITELIST=image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/heic,image/heif,video/quicktime,video/mp4
```

关闭应用白名单不能绕过服务限制。不受支持的图片格式和超过 10 MiB 的图片仍会被 Hosted Images 拒绝。受支持的视频直传 Stream 并通过 HLS 播放；binding 的 basic POST 上传要求文件小于 200 MB。R2 只保存其他非图片、非视频对象。

`STREAM` 是 capability binding，不需要应用 token 或额外 CI secret。Stream 按视频存储分钟和传输分钟计费。

Node/Docker 版本中的 storage-provider 变量（`NUXT_STORAGE_PROVIDER`、`NUXT_PROVIDER_S3_*`、`NUXT_PROVIDER_LOCAL_*` 与 `NUXT_PROVIDER_OPENLIST_*`）已经废弃，详见 [Cloudflare 存储绑定](/zh/configuration/storage-providers)。
