# 开始贡献

本文档将指导您搭建 ChronoFrame 的开发环境，包括环境要求、依赖安装、配置设置和开发工具。

## 环境要求

### 必需软件

- **Node.js**: 22.12+
- **pnpm**: 10.0+ （首选包管理器）
- **Git**: 最新版本
- **Cloudflare 账号**: 本地 mock 可选，远端集成测试必需

## 克隆与安装

### 1. 克隆代码库

```bash
# 使用 HTTPS
git clone https://github.com/HoshinoSuzumi/chronoframe.git

# 或使用 SSH
git clone git@github.com:HoshinoSuzumi/chronoframe.git

# 进入项目目录
cd chronoframe

# 设置上游远程仓库
git remote add upstream https://github.com/HoshinoSuzumi/chronoframe.git
```

### 2. 安装依赖

```bash
# 安装 pnpm（如果尚未安装）
npm install -g pnpm

# 安装项目依赖
pnpm install
```

### 3. 配置环境变量

```bash
# 按需复制公开配置
cp .env.example .env

# 本地运行时 secret 不进入 Git。复制示例，并为 NUXT_SESSION_PASSWORD 与
# CFRAME_BOOTSTRAP_TOKEN 分别填写独立的、至少 32 字符的值。本地测试签名
# 回调时，还需复制 Cloudflare 返回的 Stream webhook secret。
cp .dev.vars.example .dev.vars

# 编辑环境变量
nano .env  # 或使用您喜欢的编辑器
```

#### 最小开发配置

```bash
# === 认证设置 ===
NUXT_OAUTH_GITHUB_CLIENT_ID=your-dev-github-client-id
NUXT_OAUTH_GITHUB_CLIENT_SECRET=your-dev-github-client-secret
# NUXT_SESSION_PASSWORD、CFRAME_BOOTSTRAP_TOKEN 与 CFRAME_STREAM_WEBHOOK_SECRET 应放在 .dev.vars，而不是此公开文件。

# === 地图服务（可选） ===
NUXT_PUBLIC_MAPBOX_ACCESS_TOKEN=pk.your-development-token
NUXT_MAPBOX_ACCESS_TOKEN=sk.your-development-token

# === 开启调试信息 ===
VITE_SHOW_DEBUG_INFO=true
```

## 项目架构

### 目录结构

```
chronoframe/
├── app/                    # Nuxt 4 应用目录
│   ├── components/         # Vue 组件
│   │   ├── ui/            # 通用 UI 组件
│   │   ├── photo/         # 照片相关组件
│   │   ├── masonry/       # 瀑布流布局组件
│   │   └── ...
│   ├── pages/             # 路由页面
│   ├── composables/       # Vue 组合式函数
│   ├── stores/            # Pinia 状态管理
│   ├── layouts/           # 布局模板
│   ├── plugins/           # Nuxt 插件
│   └── utils/             # 工具函数
├── packages/
│   └── webgl-image/       # WebGL 图片查看器包
│       ├── src/
│       │   ├── core/      # 核心引擎
│       │   ├── components/ # Vue 组件
│       │   └── types/     # 类型定义
│       └── package.json
├── server/                # Nitro 服务端
│   ├── api/              # API 路由
│   │   ├── photos/       # 照片管理 API
│   │   ├── auth/         # 认证 API
│   │   └── system/       # 系统 API
│   ├── database/         # 数据库相关
│   │   ├── schema.ts     # 数据库模式
│   │   └── migrations/   # 迁移文件
│   ├── services/         # 业务逻辑服务
│   │   ├── storage/      # 存储服务
│   │   ├── image/        # 图片处理
│   │   ├── location/     # 地理位置
│   │   └── pipeline-queue/ # 处理队列
│   ├── tasks/            # 后台任务
│   └── utils/            # 服务端工具
├── shared/               # 前后端共享代码
│   ├── types/           # TypeScript 类型定义
│   └── utils/           # 共享工具函数
├── docs/                # 项目文档
├── scripts/             # 构建和部署脚本
└── 配置文件...
```

### 技术栈

#### 前端技术

- **Nuxt 4**: Vue.js 全栈框架
- **TypeScript**: 类型安全的 JavaScript
- **TailwindCSS**: 实用优先的 CSS 框架

#### 后端技术

- **Cloudflare Workers / Nitro**: 边缘服务端运行时
- **D1**: 兼容 SQLite 的 serverless 数据库
- **Drizzle ORM**: 类型安全的 ORM
- **Cloudflare Images**: Hosted Images 存储与图片转换
- **Cloudflare Stream**: 视频直传、处理与 HLS 传输
- **R2**: 其他非图片、非视频对象存储

## 开发流程

### 启动开发服务器

```bash
# 生成 bindings、初始化本地 D1 并启动 Wrangler
pnpm cf:typegen
pnpm d1:migrate:local
pnpm dev:worker
```

### 数据库操作

```bash
# 生成迁移文件
pnpm d1:generate

# 执行本地数据库迁移
pnpm d1:migrate:local
```

### 构建项目

```bash
# 构建 WebGL 依赖包
pnpm build:deps

# 构建完整 Worker 项目
pnpm build:worker

# 在 Wrangler 本地运行时预览
pnpm dev:worker
```

## 测试环境

### 本地 Cloudflare Bindings

`wrangler dev` 提供本地 D1、R2 与 Hosted Images binding 实现，本地数据与生产隔离。启动应用前先运行 `pnpm d1:migrate:local`。Stream Direct Creator Upload 与 HLS 播放需在连接账号的预览部署中验证；`.dev.vars` 中不应出现 Stream API Token。

### GitHub OAuth 应用

1. 访问 GitHub Settings > Developer settings > OAuth Apps
2. 创建新的 OAuth 应用
3. 设置回调 URL：`http://localhost:3000/api/auth/github`
4. Client ID 放入本地配置，Client Secret 放入 `.dev.vars`

### Mapbox 开发令牌

1. 注册 [Mapbox 账户](https://account.mapbox.com/)
2. 创建开发用的访问令牌
3. 设置 URL 限制：`http://localhost:3000`
4. 将令牌添加到 `.env` 文件

## 代码规范

### TypeScript 规范

```typescript
// ✅ 好的做法
interface PhotoMetadata {
  id: string
  title?: string
  width: number
  height: number
  createdAt: Date
}

// ❌ 避免使用 any
const processPhoto = (photo: any) => { ... }

// ✅ 使用具体类型
const processPhoto = (photo: PhotoMetadata) => { ... }
```

### Vue 组件规范

```vue
<!-- ✅ 推荐的组件结构 -->
<script setup lang="ts">
// 导入
import { ref, computed } from 'vue'
import type { Photo } from '~/types'

// Props 和 Emits
interface Props {
  photos: Photo[]
  loading?: boolean
}

interface Emits {
  select: [photo: Photo]
  delete: [photoId: string]
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
})

const emit = defineEmits<Emits>()

// 响应式数据
const selectedPhoto = ref<Photo | null>(null)

// 计算属性
const photoCount = computed(() => props.photos.length)

// 方法
const handlePhotoClick = (photo: Photo) => {
  selectedPhoto.value = photo
  emit('select', photo)
}
</script>

<template>
  <div class="photo-grid">
    <!-- 模板内容 -->
  </div>
</template>

<style scoped>
/* 组件样式 */
</style>
```

### 数据库调用

在 `server` 中使用数据库操作时，使用 `useDB()` 获取数据库的 Drizzle 实例。该 composable 在服务端是全局自动导入的：

```typescript
const db = useDB()

const photos = await db.select().from(photosTable)
```

### 提交信息规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
feat: 添加照片批量删除功能
fix: 修复 WebGL 查看器在 Safari 中的兼容性问题
docs: 更新部署文档
style: 统一代码格式
refactor: 重构存储服务接口
test: 添加照片上传的单元测试
chore: 更新依赖包版本
```

## 贡献指南

### 开发流程

1. **Fork 项目**: 在 GitHub 上 fork 项目
2. **创建分支**: `git checkout -b feature/new-feature`
3. **开发功能**: 编写代码和测试
4. **提交更改**: 使用规范的提交信息
5. **推送分支**: `git push origin feature/new-feature`
6. **创建 PR**: 在 GitHub 上创建 Pull Request

### Pull Request 检查清单

提交 PR 前请确保：

- 代码通过所有测试
- 遵循代码规范
- 更新相关文档
- 添加适当的测试用例
- PR 描述清晰，包含变更说明

## 贡献机会

### 适合新手的任务

寻找标有以下标签的 Issues：

- `good first issue`: 适合新手的任务
- `help wanted`: 需要社区帮助的任务
- `documentation`: 文档相关的改进

## 有用资源

### 官方文档

- [Nuxt 4 文档](https://nuxt.com/)
- [Vue 3 文档](https://vuejs.org/)
- [Drizzle ORM 文档](https://orm.drizzle.team/)
- [TailwindCSS 文档](https://tailwindcss.com/)

### 社区资源

- [GitHub Issues](https://github.com/HoshinoSuzumi/chronoframe/issues)
- [GitHub Discussions](https://github.com/HoshinoSuzumi/chronoframe/discussions)
