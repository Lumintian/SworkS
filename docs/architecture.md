# 架构说明

面向参与开发的人。使用说明见 [README](../README.md)，开发环境与命令见 [development.md](development.md)。

## 概览

SworkS 是单用户、本机运行的应用：一个 Node.js 进程同时提供 API、附件读取和构建后的网页界面，只监听 `127.0.0.1`。所有用户数据都在一个数据目录里（SQLite 数据库 + 附件文件），浏览器不保存唯一副本。

```text
浏览器（React 单页应用）
   │  fetch /api/*（修改请求带 CSRF 令牌）
   ▼
Hono 应用（src/server/http）── 安全中间件：Host / Origin / CSRF
   │
   ├─ services/entities   题目、资料、内容块、笔记、标签、来源的聚合读写
   ├─ services/ingest     粘贴/上传/URL 输入 → 原始输入记录 + 附件；远程图片归档器
   ├─ services/search     检索投影与查询
   ├─ services/backup     完整备份 / restore 恢复 / exportMarkdown 导出
   │
   ├─ better-sqlite3 ──► <数据目录>/db.sqlite3
   └─ AssetStore     ──► <数据目录>/assets/<sha[0:2]>/<sha>.<ext>
```

## 代码结构

| 目录 | 内容 |
| --- | --- |
| `src/shared/` | 前后端共享：常量与枚举、Zod 请求校验 schema 与响应类型（`api.ts`）、附件引用规则（`assetRef.ts`） |
| `src/server/cli/` | 命令行入口：`start.ts`（启动服务）、`restore.ts`（从备份恢复） |
| `src/server/db/` | 连接配置、schema、迁移 |
| `src/server/services/` | 业务逻辑（见下文各节） |
| `src/server/http/` | 路由（`app.ts`）、安全中间件（`security.ts`）、静态页面（`static.ts`） |
| `src/web/lib/` | 请求封装、路由、草稿模型、编辑页状态 hook |
| `src/web/components/`、`src/web/pages/` | 界面组件与页面 |
| `src/web/markdown/` | Markdown 渲染链与图片解析 |

TypeScript 分三个工程：服务端（`tsconfig.server.json`，NodeNext ESM，相对导入需写 `.js` 扩展名）、前端（`tsconfig.web.json`，bundler 解析，`@shared/*` 别名）、测试（`tsconfig.test.json`）。服务端由 `tsc` 编译到 `dist/node/`，前端由 Vite 构建到 `dist/web/`。

## 数据模型

表结构与约定见 [schema.md](schema.md)。核心概念：

- **题目（problem）**：由有序内容块组成，另有类型化笔记（普通笔记 / 答案 / 解析）、标签、学科、学段、来源备注，以及与资料的来源关系。标题可以为空（数据库中为 NULL）。
- **资料（material）**：独立保存的内容（专题摘录、一组截图等），同样由内容块组成，并有“待整理 / 已整理”状态；收件箱就是“待整理”资料的筛选视图。
- **内容块（content block）**：`markdown`（源码）、`text`（按字面显示的普通文字）、`image`（引用本地附件或一条远程图片记录）。每块恰好属于一个题目或一个资料。
- **附件（asset）**：原始文件字节，按内容哈希存放；每次输入都有独立的附件记录，字节可复用。
- **原始输入（raw input）**：每次外部输入收到的原文、原文件或原 URL 与采集时间。之后的编辑不会改动它。
- **远程图片（remote image）**：一个 URL 的归档状态及其本地附件。
- **检索投影（search_index）**：由正文派生，可随时重建，不进入备份。

## 启动与数据目录

`cli/start.ts` → `server.ts#startServer` → `library.ts#openLibrary`：

1. 检查数据目录：不存在或为空才初始化新库；非空却没有 `db.sqlite3` 时拒绝启动，避免覆盖已有文件。
2. 获取 `sworks.lock`，保证同一数据目录只有一个进程写入（持锁进程已退出时接管陈旧锁）。
3. 打开数据库（`db/connection.ts` 设置并读回校验 `foreign_keys`、WAL、`synchronous=FULL`、`busy_timeout`），执行 `quick_check`。损坏时报错并保留现场，不自动重建。
4. 执行迁移（`db/migrations.ts`）：已有库升级前先用 SQLite Backup API 在 `backups/` 写一份安全备份并校验，失败则停止升级。
5. `context.ts#createContext` 组装 `AppContext`（数据库、路径、限制、附件存储、远程图片归档器、下载策略、CSRF 令牌、允许的 Host/Origin），交给 `http/app.ts`。

默认数据目录的解析规则固定：`--data-dir` → 环境变量 `SWORKS_DATA_DIR` → `<程序根目录>/sworks-data`，与启动时的工作目录无关。

## 保存模型

实现在 `services/entities.ts`。

- **整体保存**：题目页一次提交属性、内容块、笔记、标签与来源；服务端在单个事务内与现有数据比对，只写入有变化的部分，并在同一事务内重建该对象的检索投影。
- **客户端生成 ID**：新建页面的 ID 在打开页面时生成并放在 URL 中（`/problems/new?id=<uuid>`）。重复提交同一个创建请求不会产生第二条记录。
- **版本条件更新**：每个题目/资料有 `write_version`。更新请求必须携带页面加载时的版本，不一致返回 409，界面提示冲突并提供“重新加载 / 另存为新对象 / 复制内容”。任何实际变化（包括笔记增删改）都递增版本并刷新修改时间；没有实际变化的保存不会。
- **软删除**：题目、资料、笔记删除后进入回收站，可以恢复。保存时没有包含的现有笔记视为删除。不做物理删除，也不回收附件文件。
- **从资料建题**：复制选定的完整内容块（新块 ID，引用同一附件），记录来源关系；之后题目与资料各自编辑，互不联动。

## 输入与附件

实现在 `services/ingest.ts`、`services/assetStore.ts`。

- 每次外部输入（粘贴文字、剪贴板/本地图片、图片 URL、单个 .md/.txt 文件）都会先写一条原始输入记录，此时尚未归属任何对象；前端在下一次保存时通过 `rawInputIds` 把它们挂到题目或资料上。
- 图片格式按文件头识别（PNG、JPEG、WebP、GIF），不信任扩展名或 Content-Type；不支持的格式明确报错。
- 附件写入顺序：写临时文件并刷盘 → 原子移动到 `assets/<sha[0:2]>/<sha>.<ext>` → 提交数据库记录。异常中断最多留下待清理的临时文件，不会出现指向不存在文件的记录。
- Markdown 中引用系统管理的附件统一写作 `assets/<asset-id>.<ext>`（`src/shared/assetRef.ts`），渲染时映射到 `/api/assets/<id>`，导出时对应导出包里的 `assets/` 目录。

## 远程图片

- 用户输入图片 URL 时立即尝试下载；保存 Markdown 时，服务端用 remark 语法树（与前端相同的 GFM + math 扩展）找出实际的图片节点，为其中的远程地址建立记录并在后台下载。代码块、行内代码和普通链接里的 URL 不会触发下载。
- **不改写 Markdown 源码**：源码里保留原 URL，显示时通过“URL → 本地附件”映射使用本地副本；未归档时只显示占位、原 URL 与失败原因，不回退到外链加载（页面 CSP 也只允许本机图片）。Markdown 导出时才把已归档的地址改写为相对路径。这样后台下载完成时不会与正在进行的编辑冲突。
- **下载器**（`services/remoteFetch.ts`）：只接受 http/https，拒绝带凭证的 URL；每一跳（含重定向）都重新解析并校验地址，只允许公网单播地址，并通过自定义 `lookup` 让实际连接使用已校验的地址（防 DNS 重绑定）；限制超时、重定向次数和大小，按文件头确认是图片。
- **fake-ip DNS**：有些网络或代理软件会把外部域名解析到保留段 `198.18.0.0/15`，默认策略会拒绝它们，并在错误信息中提示。启动参数 `--allow-fake-ip-dns` 只额外放行这一段。
- 下载失败保留 URL 与原因，可以重试或手动补传本地图片。

## 检索

实现在 `services/search.ts`。每个题目/资料保存时，把标题、内容块正文、图片说明、未删除笔记的标题与正文、标签名、来源备注按字段写入 `search_index`（统一小写）。查询对每个关键词做参数化的 `instr()` 子串匹配：多个关键词按 AND，任一字段命中即可；标签筛选单独实现，多个标签也按 AND。结果附带命中字段，界面据此提示“命中答案 / 解析 / 笔记”。不使用 LIKE 通配、分词扩展或外部搜索服务。

## 备份、恢复与导出

格式说明见 [backup-format.md](backup-format.md)。

- **备份**（`services/backup.ts`）：Backup API 一致快照 → 从快照导出逻辑记录（`backupFormat.ts` 的 `RECORD_TABLES`）→ 按快照清单读取附件并核对哈希 → 用 yazl 写临时 ZIP → 用与恢复相同的 `validateBackup` 完整校验 → 原子发布到 `backups/`。
- **恢复**（`services/restore.ts`，只通过命令行）：目标必须是新的空目录且未被占用 → 校验 ZIP（yauzl `strictFileNames`、条目白名单、拒绝符号链接与加密条目、数量与体积上限）、清单、记录与附件哈希 → 在目标旁的临时目录建库、写入记录、检查外键/数量/哈希/完整性、重建检索投影 → 全部通过后改名为目标目录。
- **Markdown 导出**（`services/exportMarkdown.ts`）：每题一个文件（YAML 元信息 + 内容 + 笔记），普通文字块用比内容更长的反引号围栏包裹，只打包实际引用的图片，未归档图片保留原 URL 并在 README 中警告。它是开放阅读格式，不承诺无损回导。

## 安全模型

本机无登录，但不允许任意网页访问本地 API（`http/security.ts`）：

- **Host 校验**：只接受本机回环地址加实际端口，防 DNS 重绑定。
- **修改类请求**：Origin（如有）必须同源，`Sec-Fetch-Site`（如有）必须为同源，且必须携带 `x-sworks-csrf` 头。令牌在进程启动时随机生成，由 `GET /api/session` 下发；跨源页面既读不到令牌，也无法在不经预检的情况下发送自定义头。服务不返回任何 CORS 头，并拒绝预检请求。
- **GET 不修改数据**；附件读取只按 ID 查库并在受控目录内取文件，禁止路径穿越。
- **页面 CSP**：脚本、样式、字体、图片只来自本机；附件响应带 `nosniff` 与 `sandbox`。
- **Markdown 渲染**：不启用原始 HTML（以文字显示），链接协议受控，KaTeX 关闭 `trust`。
- 日志不记录笔记内容、图片内容或完整 URL。

## 前端

- **路由**：`lib/router.tsx` 基于 History API，带未保存修改的离开确认（`useLeaveGuard`，同时处理关闭/刷新页面）。页面路由在 `App.tsx`。新建页的 URL 带着 ID，首次保存后把地址替换为 `/problems/<id>`，由于 React key 不变，页面不会重新挂载。
- **编辑状态**：`lib/useEntityEditor.ts` 由题目页和资料页共用，负责加载、草稿、未保存判断（比较 `lib/draft.ts` 生成的规范化载荷）、带版本的保存、冲突状态，以及轮询归档中的远程图片。只有服务端返回成功后才显示“已保存”；失败时草稿保持不变。
- **内容块编辑**：`components/BlocksEditor.tsx` 由题目与资料共用。焦点在编辑器内时，粘贴写入该编辑器（在 Markdown 编辑器里粘贴图片会上传并插入引用）；焦点不在任何编辑器时，粘贴进入收录区：图片 → 图片块，单个 URL → 按图片 URL 归档（不是图片时作为文字块保留），其他文字 → 普通文字块。
- **Markdown 渲染链**：`markdown/plugins.ts` 是唯一的配置，编辑预览、题目内容和笔记共用：
  `remark-gfm` → `remark-math` → 独占一行的 `$$…$$` 按块级公式显示 → 原始 HTML 转为文字 → `rehypeCalloutFallback`（未知 callout 类型使用通用样式并保留原类型文字；`[!type]` 必须在段首）→ `rehype-callouts` → `rehype-katex`（`throwOnError: false`，不支持的公式显示原文与错误提示）。
- **主题**：`styles/app.css` 的 `@theme` 定义配色（米色底 `#faf6f1`、石棕 `#5c4033`、鼠尾草绿 `#8b9d77`、暖棕 `#d4a373`）、衬线标题与无衬线正文、不规则圆角与弱阴影。避免纯黑、蓝紫高饱和主色、重阴影与装饰性单侧粗边框；原始题图不染色、不裁切（`object-fit: contain`）；支持 `prefers-reduced-motion`。

## 设计取舍

- **直接写 SQL，不用 ORM**：关键在于可控的事务边界、`STRICT` 表与 `CHECK` 约束、升级前安全备份，以及按表导出导入的备份格式。这些用参数化 SQL 表达最直接。
- **源码是权威内容**：保存、重排、打开预览都不改写 Markdown；远程图片通过映射而不是回写源码来使用本地副本。
- **整页保存 + 版本号**：比逐字段保存更容易保证原子性和冲突检测；自动保存暂未实现。
- **CSRF 用自定义头 + 随机令牌**：没有登录会话，令牌随进程生成；服务重启后前端会自动刷新令牌并重试一次。
- **中文 callout 默认标题**：如 `[!tip]` 显示“提示”；另有 `answer`（答案）、`solution`（解析）两个样式类型，它们只是排版语法，不改变笔记的业务类型。

## 当前限制

- 列表缩略图直接加载原图（分页 + 懒加载），不生成缩略图。
- 不回收附件文件：删除内容块或回收站中的对象都不会删除附件，附件目录只增不减。
- 远程图片下载不读取 HTTP 代理环境变量。
- 备份期间不暂停写入：快照由 Backup API 保证一致，附件文件不可变。
- 恢复只支持备份格式 v1，且只能恢复到新的空目录；没有旧版本迁移链。
- 学科/学段字典和标签没有管理界面（不能重命名、合并）。
- 测试只覆盖 Linux + Chromium。
