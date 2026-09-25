# 开发指南

架构说明见 [architecture.md](architecture.md)。

## 环境

- Node.js 24 LTS 或更新版本
- pnpm（版本见 `package.json` 的 `packageManager`）
- `better-sqlite3` 是原生模块：安装时有预编译包就直接下载，否则需要本机 C/C++ 编译工具链（Python 3、make、g++ 或对应平台的构建工具）
- 端到端测试需要 Playwright 的 Chromium：`pnpm exec playwright install chromium`

## 常用命令

```bash
pnpm install --frozen-lockfile
pnpm dev              # 开发模式，见下文
pnpm typecheck        # 服务端、前端、测试代码类型检查
pnpm test             # 单元与集成测试（Vitest）
pnpm build            # vite build → dist/web，tsc → dist/node
pnpm test:e2e         # 端到端测试（Playwright），针对 dist/ 运行，需先 pnpm build
pnpm test:all         # typecheck + test + build + test:e2e
```

运行单个测试：

```bash
pnpm exec vitest run tests/server/backup.test.ts -t "篡改附件"
pnpm exec playwright test tests/e2e/capture.spec.ts -g "两个页面"
```

## 开发模式

`pnpm dev`（`scripts/dev.mjs`）同时启动：

- 后端：`tsx watch src/server/cli/start.ts --port 4822 --no-web`，修改服务端代码后自动重启。数据目录默认 `./sworks-dev-data`（可用 `SWORKS_DATA_DIR` 覆盖，已在 `.gitignore` 中）。
- Vite 开发服务器：http://127.0.0.1:5173 ，热更新，`/api` 代理到后端。后端用 `--dev-origin` 放行 Vite 页面的 Host/Origin（只接受本机回环地址）。

后端重启后 CSRF 令牌会变化，前端会自动刷新令牌并重试一次。

## 测试

| 目录 | 说明 |
| --- | --- |
| `tests/server/` | 服务端集成测试。`tests/helpers/server.ts` 的 `makeTestApp()` 在临时目录建真实的库，通过 `app.request()` 调用 Hono 应用，并自动带上正确的 Host、Origin 与 CSRF 头 |
| `tests/render/` | Markdown / 公式 / callout 渲染测试（`renderToStaticMarkup`） |
| `tests/e2e/` | 端到端测试。`tests/e2e/helpers.ts` 以子进程启动 `dist/node/server/cli/start.js`（可重启、可调用恢复命令），用 `DataTransfer` 模拟剪贴板粘贴 |
| `tests/helpers/zip.ts` | 读写 ZIP，用于构造被篡改的备份包 |

编写测试的约定：

- 远程图片测试不访问外网：在本机起 HTTP 服务，并通过 `fetchPolicy` 注入 `isAddressAllowed`、`resolve`，让回环地址在测试中被当作“公网”。
- 模拟故障：磁盘不可写用目录只读权限（root 下跳过）；数据库异常用临时 `RAISE(ABORT)` 触发器。
- 端到端测试不能依赖外部网络或 CDN；`capture.spec.ts` 会检查页面没有向本机以外发请求。

## 依赖管理

- 只用 pnpm，提交 `pnpm-lock.yaml`。
- 版本精确锁定（不写 `^`/`~`），不引入预发布版本，也不锁定刚发布的新版本（pnpm 的最小发布时长策略会拦截它们）。
- 需要执行安装脚本的依赖（原生模块、esbuild）必须列在 `pnpm-workspace.yaml` 的 `allowBuilds` 中。
- 引入新依赖前检查许可证：`pnpm licenses list --prod`。
- 运行时不允许从 CDN 加载任何资源；字体、KaTeX 样式与字体都随构建打包。

## 修改数据库结构

1. 在 `src/server/db/migrations.ts` 新增迁移（版本号递增）。不要修改已发布的迁移，包括 `schema-v1.ts`。
2. 更新 [schema.md](schema.md)。
3. 更新备份格式：`services/backupFormat.ts` 的 `RECORD_TABLES` 与排序；递增 `BACKUP_SCHEMA_VERSION`；在恢复逻辑中为旧版本备份补上迁移路径，或明确拒绝；更新 [backup-format.md](backup-format.md)。
4. 如果新增的数据需要参与搜索，更新 `services/search.ts` 的投影。
5. 补测试：新库初始化、从旧版本升级（含升级前安全备份）、备份恢复往返。

## 约定

- 界面文字、错误信息、文档与代码注释使用中文。
- Markdown 源码是权威内容：任何功能都不能因保存、预览、排序或归档而改写用户的 Markdown。
- 只有服务端确认写入成功后，界面才显示“已保存”；错误要区分下载失败、磁盘不可写、数据库失败、保存冲突等（`src/server/errors.ts`）。
- 相关的数据库写入放在同一事务中；网络请求和文件 IO 不放进同步事务函数。
- 新增修改类接口一律走 `http/security.ts` 的校验，不返回 CORS 头；GET 接口不修改数据。
- 界面遵循 `styles/app.css` 的主题变量；原始图片使用 `object-fit: contain`，不裁切、不加滤镜。
