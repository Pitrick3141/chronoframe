# 更新 Workers 上的 ChronoFrame

ChronoFrame 会先构建发布产物，再在部署依赖新表结构的代码前应用尚未执行的数据库 migration。重大升级前请保存最新的 D1 导出，并为 Hosted Images、Stream 视频与 R2 对象建立清单/备份。

## 标准更新

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm cf:typegen
pnpm run deploy
```

部署前先审查 migration SQL 和 release notes。`pnpm run deploy` 会在修改 D1 前完成构建；随后 Wrangler 记录并只执行尚未应用的 migration，最后发布 Worker。

## 回滚预期

部署旧版 Worker 代码不会反向撤销 D1 migration。应优先采用向后兼容的 schema 变更和分阶段发布。如果必须回滚 schema，请明确恢复或转换 D1，不能仅删除 migration 记录。

Images、Stream 视频和 R2 对象变更也独立于 Worker 代码部署。批量变更应保留 migration manifest，便于逐项核对每项服务。回滚代码不会撤销 Stream 上传或已产生的传输分钟。

## GitHub Actions

Cloudflare Workers workflow 会在受保护的 `production` environment 中执行相同发布顺序：安装、校验/构建、替换配置的 D1 database ID、应用远端 migration，再部署。所需 secret 和 variable 见 [部署到 Cloudflare Workers](/zh/guide/getting-started#github-actions-部署)。

## 从旧 Docker 版本升级

不要使用 Docker 更新流程迁移到此版本。当前分支已移除 Docker 构建与镜像发布文件，因为旧 Node 运行时无法提供 D1、Hosted Images、Stream、R2 或 Assets bindings。请改用 [迁移现有安装](/zh/guide/migrate-to-workers)；只有在查阅旧容器结构时才需要查看迁移前的 release 或 Git tag。
