# 部署到 Cloudflare Workers

ChronoFrame 以 Nuxt 应用运行在 Cloudflare Workers 上。关系数据保存在 D1，所有图片二进制保存在 Cloudflare Images Hosted Images，所有视频由 Cloudflare Stream 存储和传输，其他非图片/非视频对象保存在 R2，构建后的客户端由 Workers Assets 提供。

## 前置条件

- Node.js 22.12 或更新版本、pnpm 10。
- 已启用 Workers、D1、R2 与 Stream 的 Cloudflare 账号。
- Workers Paid 计划。当前 Wrangler 压缩 bundle 超过 Workers Free 的 3 MB 脚本上限；Paid 上限为 10 MB。参见 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/#worker-size)。
- [Cloudflare Images 付费存储计划](https://developers.cloudflare.com/images/pricing/)。`wrangler` 不会自动开通 Hosted Images，请先在控制台中启用。
- Cloudflare Stream 容量。Stream 按[视频存储分钟与传输分钟](https://developers.cloudflare.com/stream/pricing/)计费。
- Wrangler 登录：本机运行 `pnpm exec wrangler login`，CI 则使用 API Token。

:::warning 图片上传限制
Hosted Images **每个已存图片最多 10 MiB**。输入格式支持 JPEG、PNG、GIF、WebP、SVG 与 HEIC；AVIF 输入仅限 Enterprise。ChronoFrame 仅为在上传前拆出附加视频而允许最多 **25 MiB** 的复合 JPEG Motion Photo；拆分后进入 Hosted Images 的静态 JPEG 仍必须不超过 10 MiB，视频部分进入 Stream。Cloudflare 还限制图片尺寸和总像素数，批量迁移前请查看最新的 [Cloudflare Images 限制](https://developers.cloudflare.com/images/get-started/limits/)。
:::

:::warning 视频直传限制
`STREAM` binding 当前创建 basic POST Direct Creator Upload URL，Cloudflare 只允许用它上传 **小于 200 MB** 的视频。ChronoFrame 因此默认限制为 **199999999 字节**。更大文件必须使用 tus 协议，而当前上传流程尚未实现 tus。默认最大视频时长为 **600 秒**。
:::

## 1. 安装并登录

```bash
pnpm install
pnpm exec wrangler login
```

## 2. 创建 Cloudflare 资源

创建 D1，并将命令返回的 UUID 填入 `wrangler.jsonc`，替换占位的 `database_id`：

```bash
pnpm d1:create
```

创建 `wrangler.jsonc` 中声明的 R2 存储桶：

```bash
pnpm exec wrangler r2 bucket create chronoframe-storage
```

在 Cloudflare 控制台中启用 Images。ChronoFrame 不要求账户级交付变体：`/media/images/:id` 先按 D1 校验可见性，再返回最长边不超过 4096 px、已剥离元数据的 WebP 展示图；`/media/images/:id/thumbnail` 返回 600 px WebP 缩略图。Hosted Image 原始字节只能由管理员通过 `/media/images/:id/source` 获取。

不要为 ChronoFrame 媒体开放始终公开的 Hosted Images 变体，否则会绕过同源 Worker 路由执行的隐藏相册 ACL。外部集成若必须直接使用 Images 交付，仍需保持签名 URL 保护并实现等价鉴权。

在 Cloudflare 控制台中启用 Stream。`STREAM` binding 本身就是应用访问 Stream 的授权，不要在 ChronoFrame 设置中创建或保存 Stream API Token。

## 3. 核对绑定

Worker 使用以下固定绑定名：

| 绑定           | Cloudflare 资源                 | 用途                                      |
| -------------- | ------------------------------- | ----------------------------------------- |
| `DB`           | D1 数据库 `chronoframe-db`         | 用户、设置、照片元数据、相册与任务状态    |
| `IMAGES`       | Cloudflare Images Hosted Images | 所有上传图片                              |
| `STREAM`       | Cloudflare Stream               | 所有视频，包括 Live/Motion Photo 视频伴侣 |
| `MEDIA_BUCKET` | R2 存储桶 `chronoframe-storage`   | 其他非图片、非视频对象                    |
| `ASSETS`       | `.output/public`                | Nuxt 客户端资源                           |

不要在 Nuxt 设置中填写存储访问密钥；Worker 通过绑定访问这些资源。

### 视频上传与播放

上传视频时，已认证的 Worker 使用 `requireSignedURLs: true` 和默认 `maxDurationSeconds: 600` 调用 `STREAM.createDirectUpload()`。Binding 返回一次性 URL 和 Stream video ID，浏览器再将 multipart 文件直接发送到 Cloudflare Stream，不会暴露 API Token。Stream 处理完成后，D1 只保存同源播放路由 `/media/streams/:photoId/manifest.m3u8`；该路由先执行照片/相册可见性检查，再通过 Stream binding 生成短时令牌并重定向到签名 HLS manifest。照片 API 不会返回 Cloudflare HLS/DASH 直连地址。详见 [Direct Creator Uploads](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/)。

上传 URL 等待使用时，预留时长会占用 Stream 存储容量；处理完成后按视频实际存储时长计费，播放则按传输分钟计费。

## 4. 设置初始化 Secret

首次部署前，为 session 和初始化向导生成两个彼此独立、至少 32 字符的高熵随机值：

```bash
openssl rand -base64 32
pnpm exec wrangler secret put NUXT_SESSION_PASSWORD
openssl rand -base64 32
pnpm exec wrangler secret put CFRAME_BOOTSTRAP_TOKEN
```

Stream webhook secret 会在第 5 节首次部署完成、确定公开回调 URL 后添加。仅在本地开发时，把已有值放入不提交的 `.dev.vars`：

```dotenv
NUXT_SESSION_PASSWORD=replace-with-at-least-32-random-characters
CFRAME_BOOTSTRAP_TOKEN=replace-with-a-different-32-character-random-token
CFRAME_STREAM_WEBHOOK_SECRET=copy-result-secret-from-stream-webhook-api
```

bootstrap token 用于为首次初始化请求鉴权；它不是管理员密码，也不能存入 D1 或 Wrangler 的明文 `vars`。其他仅服务端使用的凭据也应通过 `wrangler secret put` 设置。站点需要的公开 `NUXT_PUBLIC_*` 构建变量可按需配置。

请在初始化向导的完成页面输入该 token。浏览器仅在这次请求中通过 `X-Chronoframe-Bootstrap-Token` header 发送它，不会持久化。API 客户端也可使用同名 header，或兼容的顶层 `bootstrapToken` body 字段。

## 5. 应用 D1 migrations 并部署

云端自动部署请配置下文的 [Cloudflare GitHub 集成](#cloudflare-github-integration)。以下命令用于本地手动部署。

部署命令会先完成构建，再应用已追踪但尚未执行的 D1 migrations，随后立即部署匹配的 Worker 产物：

```bash
pnpm run deploy
```

`pnpm run deploy` 会构建工作区依赖和 Nuxt Worker bundle，再调用 Wrangler。当前配置部署到 `photograph.pitrick.dev` 并关闭 `workers.dev`；可在 **Workers & Pages > chronoframe > Settings > Domains & Routes** 管理域名，并同步维护 `wrangler.jsonc`。

### 注册 Stream webhook

接受任何视频上传前，使用已部署的 HTTPS 地址注册账户级 webhook。调用此 API 的配置 Token 需要 Stream Edit 权限，可以与 CI Token 分开：

```bash
curl --request PUT \
  --url "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/stream/webhook" \
  --header "Authorization: Bearer <STREAM_EDIT_API_TOKEN>" \
  --header "Content-Type: application/json" \
  --data '{"notificationUrl":"https://<CHRONOFRAME_HOST>/api/webhooks/cloudflare-stream"}'

# 原样粘贴 API 响应中的 result.secret。
pnpm exec wrangler secret put CFRAME_STREAM_WEBHOOK_SECRET
```

`wrangler secret put` 会发布包含加密 secret 的 Worker 版本。每个 Cloudflare 账户只能配置一个 Stream webhook；更新订阅会轮换返回的 secret，必须同步更新 Worker secret。完成此步骤前不要开放视频上传。

### 保护登录接口

开放公网访问前，请绑定生产自定义域名，并为精确路径 `/api/login` 创建 [Cloudflare WAF 速率限制规则](https://developers.cloudflare.com/waf/rate-limiting-rules/)。按源 IP 计数并使用 Managed Challenge 或阻断动作；可以从每分钟 5 次、缓解时长 10 分钟开始，再按生产分析数据调整。若 Zone 套餐支持按 HTTP 方法匹配，请把规则限制为 `POST`。

切流量后应关闭公开的 `workers.dev` 路由和 Preview URLs，避免它们成为绕过 Zone 规则的备用入口。ChronoFrame 不使用 Worker 内存计数器，因为不同 isolate 不共享持久的限流状态。

如果 Stream webhook 最初使用 `workers.dev` 地址注册，必须在关闭该路由**之前**把 `notificationUrl` 更新为生产自定义域。此更新会轮换 `result.secret`，请立即用新值再次执行 `wrangler secret put CFRAME_STREAM_WEBHOOK_SECRET`。

## 本地开发

生成绑定类型、初始化本地 D1，再启动 Wrangler 本地运行时：

```bash
pnpm cf:typegen
pnpm d1:migrate:local
pnpm dev:worker
```

本地 D1 与 R2 数据保存在 Wrangler 本地状态目录。Hosted Images 绑定使用 Wrangler 的本地 mock，本地上传不会写入生产 Images 账号。发布前应在已部署的预览环境验证账号支持的 Direct Creator Upload 与 HLS 播放链路。

新增 migration 后再次运行 `pnpm d1:migrate:local`。可用 `pnpm exec wrangler d1 execute DB --local --command "SELECT 1"` 快速检查绑定。

## Cloudflare GitHub 集成 {#cloudflare-github-integration}

云端部署由 **Cloudflare Workers Builds** 直接连接 GitHub 执行，仓库不再包含 GitHub Actions 部署工作流。

当前站点进入 **Workers & Pages > chronoframe > Settings > Builds > Connect**，授权 Cloudflare GitHub App 访问 `Pitrick3141/chronoframe` 并选择该仓库。连接名称与 `wrangler.jsonc` 一致的现有 Worker。

| 设置 | 值 |
| --- | --- |
| 生产分支 | `main` |
| 根目录 | `/`（仓库根目录） |
| Build command | `pnpm run build:cloudflare` |
| Deploy command | `pnpm run deploy:cloudflare` |
| 非生产分支构建 | 关闭 |
| 将来启用非生产分支时的部署命令 | `pnpm exec wrangler deploy --dry-run --config wrangler.jsonc`（仅验证） |
| 构建变量 | `PNPM_VERSION=10.34.1` |
| Node.js | 由 `.node-version` 选择 Node 22 |

Workers Builds 根据已提交的 pnpm 锁文件安装依赖。`build:cloudflare` 依次生成 binding 类型、检查本地 D1 迁移、lint、构建工作区依赖、类型检查、构建 Nuxt，最后执行 Wrangler dry-run；这一步不修改生产数据库。

`deploy:cloudflare` 检查构建产物，再应用尚未执行的**远端 D1 迁移**并发布已构建的 Worker。云端 Deploy command 不要填写本地完整命令 `pnpm run deploy`，否则会重复构建。部署脚本会在执行远端迁移之前拒绝 Workers Builds 的非 `main` 分支。

上述脚本中的 Wrangler 命令显式选择根目录 `wrangler.jsonc`，确保 Nuxt 生成构建重定向配置后，D1 迁移目录和生产兼容参数仍以仓库配置为准。

在 **Settings > Builds > API token** 选择部署令牌。除 Worker 部署权限外，确认令牌具有 **D1 Edit**；Cloudflare 文档列出的自动生成 build token 默认权限不包含 D1。自定义域名还需要保留 Workers Routes 权限。部署令牌和 GitHub App 授权由 Cloudflare 管理，无需配置 GitHub Actions secrets。

资源 ID、绑定名和 `photograph.pitrick.dev` 由 `wrangler.jsonc` 管理。部署到新账号时，应先修改该文件中的资源配置；不再通过 CI 替换 `CLOUDFLARE_D1_DATABASE_ID`。

运行时密钥继续放在 **Settings > Variables & Secrets**：`NUXT_SESSION_PASSWORD`、`CFRAME_BOOTSTRAP_TOKEN`、`CFRAME_STREAM_WEBHOOK_SECRET`。构建变量与运行时变量是不同范围，不能互相代替。连接当前站点时保留已有密钥和 Stream webhook；`STREAM` capability binding 不需要应用级 `STREAM_API_TOKEN`。

首次集成构建前，将新脚本和工作流删除一起提交并推送到 `main`。之后每次推送会触发 Cloudflare 构建，日志和重试入口都在 Worker 的 Builds 页面。新安装仍需完成上文的资源、密钥和 Stream webhook 配置。

参考：[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[构建环境与工具版本](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)、[GitHub App 连接](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)。

## 从旧 Docker 版本迁移

当前分支已移除 `Dockerfile`、`docker-compose.yml` 与镜像发布 workflow。这些入口无法提供本 Workers-only 版本要求的 D1、Images、Stream、R2 与 Assets bindings。如需在迁移时查阅旧容器结构，请使用迁移到 Workers 之前的 release 或 Git tag。

从现有 Docker 安装升级时，请先按 [迁移现有安装](/zh/guide/migrate-to-workers) 完成数据搬迁，再切换流量。
