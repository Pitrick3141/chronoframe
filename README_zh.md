# ChronoFrame

<p align="center">
  <img src="https://socialify.git.ci/HoshinoSuzumi/chronoframe/image?custom_description=Self-hosted+personal+gallery+application.&description=1&font=KoHo&forks=0&issues=0&logo=https%3A%2F%2Fgithub.com%2FHoshinoSuzumi%2Fchronoframe%2Fraw%2Frefs%2Fheads%2Fmain%2Fpublic%2Ffavicon.svg&name=1&owner=1&pattern=Plus&pulls=0&stargazers=0&theme=Auto" alt="Chronoframe">
</p>

<p align="center">
  <a href="https://github.com/HoshinoSuzumi/chronoframe/releases/latest">
    <img src="https://badgen.net/github/release/HoshinoSuzumi/chronoframe/stable?label=稳定" alt="Latest Release">
  </a>
  <a href="https://github.com/HoshinoSuzumi/chronoframe/releases?q=beta&expanded=false">
    <img src="https://badgen.net/github/release/HoshinoSuzumi/chronoframe?label=测试" alt="Latest Nightly Release">
  </a>
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License">
</p>

<p align="center">
  <a href="https://discord.gg/MM4ZK4Ed7s">
    <img src="https://dcbadge.limes.pink/api/server/https://discord.gg/MM4ZK4Ed7s" alt="Discord Server" />
  </a>
</p>

<p align="center">
  <a href="https://hellogithub.com/repository/HoshinoSuzumi/chronoframe" target="_blank"><img src="https://api.hellogithub.com/v1/widgets/recommend.svg?rid=947d47ffe8404985908b266e187dec99&claim_uid=kLVoiAFPJaBtr1D&theme=neutral" alt="Featured｜HelloGitHub" style="width: 250px; height: 54px;" width="250" height="54" /></a>
  <a href="https://www.producthunt.com/products/chronoframe?embed=true&utm_source=badge-featured&utm_medium=badge&utm_source=badge-chronoframe" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1029556&theme=neutral&t=1761159404569" alt="ChronoFrame - Self&#0045;hosted&#0032;photo&#0032;gallery&#0032;for&#0032;photographers&#0046; | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>
</p>

**Languages:** [English](README.md) | 中文

丝滑的照片展示和管理应用，支持多种图片格式和大尺寸图片渲染。

[在线演示: TimoYin's Mems](https://lens.bh8.ga)

## ✨ 特性

### 🖼️ 强大的图片管理

- **在线管理照片** - 通过 Web 界面轻松管理和浏览照片
- **探索地图** - 在地图上浏览照片拍摄位置
- **照片元数据** - 保留受支持的拍摄时间、地理位置和相机信息
- **地理位置识别** - 自动识别(Reverse Geocoding)照片拍摄地点
- **多格式支持** - 支持 JPEG、PNG、HEIC/HEIF 等主流图片格式
- **Cloudflare 交付** - 在边缘返回剥离元数据的 WebP 展示图并动态生成 WebP 缩略图

### 🔧 现代技术栈

- **Nuxt 4** - 基于最新的 Nuxt 框架，提供 SSR/SSG 支持
- **TypeScript** - 完整的类型安全保障
- **TailwindCSS** - 现代化的 CSS 框架
- **Drizzle ORM** - 类型安全的数据库 ORM

### ☁️ Cloudflare 原生存储

- **D1** 通过 `DB` 绑定存储应用与照片元数据。
- **Cloudflare Images Hosted Images** 通过 `IMAGES` 保存全部图片。
- **Cloudflare Stream** 通过 `STREAM` 保存并传输全部视频。
- **R2** 通过 `MEDIA_BUCKET` 保存其他非图片、非视频对象。
- **Workers Assets** 通过 `ASSETS` 提供构建后的 Nuxt 客户端资源。

## ☁️ 部署到 Cloudflare Workers

ChronoFrame 现在仅支持 Cloudflare Workers 运行环境。当前压缩 bundle 超过 Workers Free 的 3 MB 脚本上限，因此需要 Workers Paid 计划；还需启用 Cloudflare Images 付费存储计划与 Cloudflare Stream。Hosted Images 单图上限为 10 MiB；支持 JPEG、PNG、GIF、WebP、SVG 与 HEIC，AVIF 输入仅限 Enterprise。公开 Worker 路由通过 Images binding 返回最长边不超过 4096 px、已剥离元数据的 WebP 展示图，并生成 600 px WebP 缩略图；Hosted Image 原始源文件仅管理员可访问，应用不使用账户级交付变体。Stream 按[视频存储分钟和传输分钟](https://developers.cloudflare.com/stream/pricing/)计费。

视频上传时，Worker 使用 `STREAM` binding 创建一次性的 Direct Creator Upload URL，浏览器将 multipart POST 直接发送到 Stream，处理完成后通过 HLS 播放。Cloudflare binding 的 basic POST 流程要求文件小于 200 MB；ChronoFrame 因此默认限制为 `199999999` 字节。默认最大时长为 600 秒，应用和浏览器都不需要接触 Stream API Token。

```bash
pnpm install
pnpm exec wrangler login

# 创建 D1，并将返回的 database_id 填入 wrangler.jsonc。
pnpm d1:create

# 创建 wrangler.jsonc 中声明的 R2 存储桶。
pnpm exec wrangler r2 bucket create chronoframe-media

# 在 Cloudflare 控制台启用 Stream；STREAM 使用 binding，无需应用 token。

# 保存两个独立随机值并完成首次部署。
pnpm exec wrangler secret put NUXT_SESSION_PASSWORD
pnpm exec wrangler secret put CFRAME_BOOTSTRAP_TOKEN

# 构建、应用尚未执行的 D1 migrations 并部署。
pnpm run deploy

# 用已部署 URL 注册 Stream webhook，再保存其 result.secret。
pnpm exec wrangler secret put CFRAME_STREAM_WEBHOOK_SECRET
```

`wrangler.jsonc` 中的绑定名必须保持为 `DB`、`IMAGES`、`STREAM`、`MEDIA_BUCKET` 与 `ASSETS`。资源创建、本地开发、CI、限制和自定义域名说明见 [Workers 部署指南](./docs/zh/guide/getting-started.md)。

当前分支已移除旧 Docker 构建、Compose 配置与镜像发布 workflow，因为它们无法提供本版本要求的 Worker bindings。如需迁移参考，请查看迁移到 Workers 之前的 release 或 Git tag。

## 📖 使用指南

首次启动时，请打开初始化向导并创建管理员账号。向导要求提供
`CFRAME_BOOTSTRAP_TOKEN`；ChronoFrame 不提供默认管理员密码。

### 登录到控制台

1. 点击头像跳转到登录页面，可以使用账号密码或 GitHub 登录

### 上传照片

1. 访问仪表板页面 `/dashboard`
2. 在 `Photos` 页面中选择图片并点击上传（支持批量上传和拖拽上传）
3. Worker 将图片保存到 Hosted Images，视频由浏览器直传 Stream，R2 只保存其他对象类型

## 📸 截图

![Gallery](./docs/images/screenshot1.png)
![Photo Detail](./docs/images/screenshot2.png)
![Map Explore](./docs/images/screenshot3.png)
![Dashboard](./docs/images/screenshot4.png)

## 🛠️ 开发

### 环境要求

- Node.js 22.12+
- pnpm 10+
- 已启用 D1、R2、Workers、Images 付费存储与 Stream 的 Cloudflare 账号

### 安装依赖

```bash
# 使用 pnpm (推荐)
pnpm install

# 或使用其他包管理器
npm install
yarn install
```

### 数据库初始化

```bash
# 生成 Worker 绑定类型并初始化本地 D1。
pnpm cf:typegen
pnpm d1:migrate:local
```

### 启动开发服务器

```bash
pnpm dev:worker
```

应用将在 `http://localhost:3000` 启动。

### 项目结构

```
chronoframe/
├── app/                    # Nuxt 应用
│   ├── components/         # 组件
│   ├── pages/              # 页面路由
│   ├── composables/        # 组合式函数
│   └── stores/             # Pinia 状态管理
├── packages/
│   └── webgl-image/        # WebGL 图片查看器
├── server/
│   ├── api/                # API 路由
│   ├── database/           # 数据库 schema 和迁移
│   └── services/           # 业务逻辑服务
└── shared/                 # 共享类型和工具
```

### 构建命令

```bash
# 本地 Worker 环境；Stream E2E 需要连接账号的预览部署
pnpm dev:worker

# 仅构建依赖包
pnpm build:deps

# 构建生产 Worker
pnpm build:worker

# 数据库操作
pnpm d1:generate          # 生成迁移文件
pnpm d1:migrate:local     # 应用本地迁移
pnpm d1:migrate:remote    # 应用生产迁移

# 部署到 Cloudflare Workers
pnpm run deploy
```

## 🤝 贡献

欢迎贡献代码！请确保：

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 开启 Pull Request

### 开发规范

- 使用 TypeScript 进行类型安全的开发
- 遵循 ESLint 和 Prettier 代码规范
- 更新相关文档

## 📄 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。

## 👤 作者

**Timothy Yin**

- Email: master@uniiem.com
- GitHub: [@HoshinoSuzumi](https://github.com/HoshinoSuzumi)
- Website: [bh8.ga](https://bh8.ga)
- Gallery: [lens.bh8.ga](https://lens.bh8.ga)

## ❓ FAQ

<details>
  <summary>如何创建管理员用户？</summary>
  <p>
    打开首次启动向导，用 <code>CFRAME_BOOTSTRAP_TOKEN</code> 完成鉴权，然后自行设置管理员邮箱、显示名称和密码。ChronoFrame 不附带默认管理员凭据。
  </p>
</details>
<details>
  <summary>支持哪些图片格式？</summary>
  <p>
    Hosted Images 支持 JPEG、PNG、GIF、WebP、SVG 与 HEIC，单图最多 10 MiB；AVIF 输入需要 Cloudflare Enterprise。所有受支持的视频上传（包括 Live/Motion Photo 伴侣）均由 Cloudflare Stream 保存和传输。
  </p>
</details>
<details>
  <summary>能否使用 S3、本地、OpenList 或 GitHub 存储？</summary>
  <p>
    Workers 版本使用固定 bindings：图片使用 Hosted Images，视频使用 Stream，其他对象使用 R2，记录使用 D1。旧 storage provider 仅存在于历史容器版本和 Git tags 中。
  </p>
</details>
<details>
  <summary>为什么需要/如何配置地图服务？</summary>
  <p>
    地图服务用于浏览照片位置和渲染详情页小地图。请按配置指南使用对应的 <code>NUXT_PUBLIC_*</code> 变量配置 MapLibre 或 Mapbox。
  </p>
</details>
<details>
  <summary>为什么我上传的 MOV 文件没有被识别为实况照片？</summary>
  <p>
    需要确保实况照片对的图片(.heic)和视频(.mov)的文件名一致（例如 <code>IMG_1234.heic</code> 与 <code>IMG_1234.mov</code> 会自动匹配）。
    一般情况来说，不管是上传 .heic 还是 .mov，都会检测一次配对，因此上传的顺序无关紧要。
    如果仍然没有被识别为实况照片，请在仪表盘中找到图片，在操作菜单中手动触发配对检测。
  </p>
</details>
<details>
  <summary>如何导入存储中已有的照片？</summary>
  <p>
    当前没有自动扫描/导入器。请按照<a href="./docs/zh/guide/migrate-to-workers.md">迁移清单</a>显式转换 SQLite 记录并迁移 Images、Stream 与 R2 对象。
  </p>
</details>

## 🙏 致谢

本项目受启发于 Afilmory，同样优秀的个人相册项目。

感谢以下优秀的开源项目和库：

- [Nuxt](https://nuxt.com/)
- [TailwindCSS](https://tailwindcss.com/)
- [Drizzle ORM](https://orm.drizzle.team/)

## ⭐️ Star History

<a href="https://www.star-history.com/#HoshinoSuzumi/chronoframe&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HoshinoSuzumi/chronoframe&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HoshinoSuzumi/chronoframe&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=HoshinoSuzumi/chronoframe&type=date&legend=top-left" />
 </picture>
</a>
