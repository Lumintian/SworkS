# 架构说明

面向参与开发的人。使用说明见 [README](../README.md)，开发环境与命令见 [development.md](development.md)。

## 概览

SworkS 是单用户、本机运行的家教工作台：收集与整理题目和资料，用自定义属性（题型、难度、考点树等）分类，并按学生记录作答流水。一个 Node.js 进程同时提供 API、附件读取和构建后的网页界面，只监听 `127.0.0.1`。所有用户数据都在一个数据目录里（SQLite 数据库 + 附件文件），浏览器不保存唯一副本。

```text
浏览器（React 单页应用）
   │  fetch /api/*（修改请求带 CSRF 令牌）
   ▼
Hono 应用（src/server/http）── 安全中间件：Host / Origin / CSRF
   │  routes/*（只做参数校验、调用服务）       GET /api/events ◄── SSE 推送变更
   │                                                   ▲
   ├─ ops/*               MCP / 插件共用的操作（校验、权限、来源）│
   │                                                   │
   │   服务层写事务 ─ record*() → 临时表 sworks_changes ─提交后→ EventBus
   │
   ├─ services/entities   题目、资料、内容块、笔记、标签、属性取值、来源的聚合读写
   ├─ services/batch      多选后的批量操作（标签、学科/学段、属性、整理状态、回收站）
   ├─ services/taxonomy   标签（按路径）与学科/学段字典的改名、合并、删除
   ├─ services/properties 自定义属性、选项树、取值、大纲导入
   ├─ services/students   学生与作答流水、统计、薄弱考点
   ├─ services/ingest     粘贴/上传/URL 输入 → 原始输入记录 + 附件；远程图片归档器
   ├─ services/search     检索投影、查询语言编译、相关度与命中片段；savedSearches 常用检索
   ├─ services/backup     完整备份 / restore 恢复 / exportMarkdown 导出
   │
   ├─ better-sqlite3 ──► <数据目录>/db.sqlite3
   └─ AssetStore     ──► <数据目录>/assets/<sha[0:2]>/<sha>.<ext>
```

## 代码结构

| 目录 | 内容 |
| --- | --- |
| `src/shared/` | 前后端共享：常量与枚举、Zod 请求校验 schema 与响应类型（`api.ts`）、错误码（`errors.ts`）、附件引用规则（`assetRef.ts`） |
| `src/server/cli/` | 命令行入口：`start.ts`（启动服务）、`restore.ts`（从备份恢复）、`mcp.ts`（MCP stdio 桥） |
| `src/server/db/` | 连接配置、schema、迁移 |
| `src/server/services/` | 业务逻辑（见下文各节） |
| `src/server/http/` | 组合（`app.ts`）、按领域拆分的路由（`routes/*.ts`，各导出 `register(app, ctx)`）、路由工具（`helpers.ts`）、安全中间件（`security.ts`）、静态页面（`static.ts`） |
| `src/server/events/` | 变更记录（`changes.ts`）、事件总线（`bus.ts`）、SSE 推送（`sse.ts`）、事件类型（`types.ts`） |
| `src/server/ops/` | 操作注册表（`registry.ts`）与内置操作：MCP 工具和插件共用的能力面 |
| `src/server/mcp/` | MCP 设置（`config.ts`，mcp.json）与服务（`server.ts`，由操作生成工具） |
| `src/server/plugins/` | 插件接口（`api.ts`，目前只有类型；设计见 [plugins.md](plugins.md)） |
| `src/web/lib/` | 请求封装、路由、草稿模型、编辑页状态 hook |
| `src/web/components/`、`src/web/pages/` | 界面组件与页面 |
| `src/web/markdown/` | Markdown 渲染链与图片解析 |

TypeScript 分三个工程：服务端（`tsconfig.server.json`，NodeNext ESM，相对导入需写 `.js` 扩展名）、前端（`tsconfig.web.json`，bundler 解析，`@shared/*` 别名）、测试（`tsconfig.test.json`）。服务端由 `tsc` 编译到 `dist/node/`，前端由 Vite 构建到 `dist/web/`。

## 数据模型

表结构与约定见 [schema.md](schema.md)。核心概念：

- **题目（problem）**：由有序内容块组成，另有类型化笔记（普通笔记 / 答案 / 解析，可带可选序号，例如对应第几问）、标签、学科、学段、自定义属性取值、来源备注，以及与资料的来源关系。标题可以为空（数据库中为 NULL）。
- **标签（tag）**：随手打的自由标记，用 `/` 表示层级（沿用 Obsidian 的约定，例如 `方法/换元`）。层级由名称推导（`src/shared/tagPath.ts`），数据库只存完整名称；筛选某个路径时包含整棵子树。
- **自定义属性（property）**：受控词表，参照 Obsidian 属性 / Notion 字段。类型有文本、数字、日期、勾选、单选、多选；单选/多选的选项可以成树。预置三个：题型（分层单选，例如“英语/完型填空”）、难度（有顺序的单选：容易→困难）、考点（层级多选，即考点树）。取值按选项 ID 保存，所以选项改名、移动不改动题目内容。单选/多选属性可以随时改为分层（选项都在顶层，路径不变），有下级选项时不能改回；界面上不单独勾选“分层”，而是在第一次新建下级、把选项拖到另一个选项上或导入带层级的大纲时说明后果（选上级含全部下级、单选不能再比较先后）并确认；同名的末级选项可以出现在不同上级下（“通用/选择”与“英语/选择”）。单选可以只选上级。编辑页里，选项少且不分层的单选用分段按钮，分层单选（≤40 个选项、≤3 级）逐级用分段按钮，其余用可搜索、可新建“上级/名称”的选择器；列表小标签只显示末级，末级重名时显示完整路径。以后要加“教材章节”这类树，只是再建一个层级属性。
- **学生（student）与作答（attempt）**：每次作答一条流水（结果、主观难度、备注、时间），参照 Anki 的 revlog；做过几次、错几次、最近一次结果、当前错题、薄弱考点都由流水统计。作答与题目内容相互独立。
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
- **属性取值**：保存请求里的 `properties` 可以省略（表示不动）；提供时就是全部未归档、适用属性的完整取值，没有出现的视为清空。已归档或不再适用的属性，其取值冻结保留。
- **批量操作与管理操作**（`services/batch.ts`、`taxonomy.ts`、`properties.ts`）：凡是改变了题目/资料内容的（加减标签、改学科学段、设置属性、标签改名合并、删除或合并选项…），都在同一事务里对**真正变化的对象**递增 `write_version`、刷新 `updated_at` 并重建检索投影。原因：编辑页保存时提交的是整份内容（标签按名称），不递增版本的话，仍开着的旧页面一保存就会把旧值写回；递增后旧页面保存会得到 409。只影响显示文字的操作（选项改名、移动）只重建检索投影。管理操作先收集受影响的对象，事务结束前由 `touch.ts#makeToucher` 统一递增版本与重建投影：一个操作可能分几步改同一个对象（例如多个选项依次合并到同一目标），边改边重建会把中间状态留在投影里。
- **版本只在一处递增**：`services/versioning.ts#bumpVersion` 是递增 `write_version`/`updated_at` 的唯一入口，同时记录一条变更；整体保存、批量与管理操作、回收站、恢复笔记都经过它。移入/移出回收站同样刷新 `updated_at`。题目与资料的整体保存共用 `entities.ts` 内部的 `saveEntity`（两类对象的差异写在 `ENTITY_SPEC`）。
- **作答记录**：单独保存，立即生效，不递增题目版本；按客户端 ID 幂等。
- **从资料建题**：复制选定的完整内容块（新块 ID，引用同一附件），记录来源关系；之后题目与资料各自编辑，互不联动。

## 变更事件与操作

- **变更记录**（`events/changes.ts`）：服务层在写事务内调用 `recordEntity/recordCatalog/recordAttempt/recordRawInput/recordRemoteImage`，把“什么变了”写进连接私有的临时表 `temp.sworks_changes`（`temp_store=MEMORY`）。事务回滚时这些行一起消失，所以失败的写入不会发出事件。提交后由 `setImmediate` 统一取出：清空临时表 → 按来源分组 → 查出对象当前版本 → 发到 `EventBus`。同一批里同一对象只出现一次；只重建了检索投影、版本没变的对象列在 `reindexOnly`。
- **来源**：`AsyncLocalStorage`（`originStore`）。中间件把非 GET 的 `/api/*` 请求包在 `{kind:'web', clientId}` 里（`clientId` 来自页面发送的 `x-sworks-client` 头，即标签页 ID）；远程图片归档器用 `{kind:'system', source:'archiver'}`；MCP 与插件调用操作时各自带上来源。
- **事件总线**（`events/bus.ts`）：处理器各自在微任务里运行并捕获异常，失败只记日志，永远不影响写入方。事件只含 ID、版本与来源，不含内容。
- **推送给页面**（`GET /api/events`，`events/sse.ts`）：先发 `hello {bootId, seq}`，之后每条变更一个 `event: change`（`id` 为递增序号），25 秒一次心跳注释。保留最近 500 条：重连时 `Last-Event-ID` 在范围内就补发，否则（太旧或服务重启过）发 `reset`。
- **页面侧**（`web/lib/serverEvents.ts`）：浏览器对同一主机只开 6 条 HTTP/1.1 连接，所以用 Web Locks（`sworks-events`）选出唯一一个持有 EventSource 的标签页，经现有 BroadcastChannel 转发给其他标签页。编辑页忽略自己发起的（`originClient === TAB_ID`）与版本一致的事件，其余沿用“没有未保存修改就自动刷新、有就提示已在别处修改”；列表缓存合并 150ms 再失效；`reset` 或 `bootId` 变化时全部重新获取。不支持 Web Locks 时退回只有同浏览器标签页之间的通知。
- **server.json**：监听成功后在数据目录写 `server.json {pid, port, url, bootId, startedAt, appVersion}`（0600，临时文件 + 改名），关闭时删除；供命令行工具（MCP stdio 桥）找到运行中的服务。同时发出 `server.started` / `server.stopping`。
- **操作注册表**（`ops/`）：MCP 工具与插件共用的约 15 个操作（检索、读题、新建题目、加笔记、按名称设属性、加减标签、记录作答、移到回收站……）。每个操作有 zod 输入、中文说明与权限级别（read / write / destructive）；`invokeOp` 统一做权限检查（只读调用方不能写）→ 输入校验 → 取消检查 → 以调用方来源运行。写操作通过 `patchProblem`：同一事务里读出整份题目 → 修改 → 走现有整体保存，不新增写入路径，版本、检索投影、409 等不变量照常成立。属性与选项按名称和路径指定（`ops/resolve.ts`：先精确匹配完整路径，再按末尾几段匹配，多个匹配时报错）。REST 路由照旧直接调用服务。
- **错误码**（`shared/errors.ts`）：前后端共用 `ErrorCode` 与状态码表，包括安全中间件的 `FORBIDDEN_HOST`、`FORBIDDEN_ORIGIN`、`CSRF` 与 MCP 用的 `UNAUTHORIZED`。数据库的原始报错只写日志，对外映射为中文说明（约束冲突 → “数据库约束冲突，数据未保存”，`SQLITE_FULL` → `DISK_WRITE_FAILED`，`SQLITE_BUSY` → `BUSY`）。

## 输入与附件

实现在 `services/ingest.ts`、`services/assetStore.ts`。

- 每次外部输入（粘贴文字、剪贴板/本地图片、图片 URL、单个 .md/.txt 文件）都会先写一条原始输入记录，此时尚未归属任何对象；前端在下一次保存时通过 `rawInputIds` 把它们挂到题目或资料上。
- 图片格式按文件头识别（`services/imageSniff.ts`：PNG、JPEG、WebP、GIF，以及按 `ftyp` 品牌识别的 HEIC/HEIF、AVIF），不信任扩展名或 Content-Type；不支持的格式明确报错。格式清单只有一份（`shared/constants.ts`）：附件只会是可存储的四种（assets 表的 CHECK、附件路径与备份格式都依赖它），HEIC/HEIF/AVIF 只能输入。
- **收录时的格式转换**（`services/imageConvert.ts`，只对新收录的图片；已有附件不动；策略 `library_meta.image_policy`，在“设置”页修改，随备份）：
  - PNG（截图）→ 无损 WebP（`exact`，逐像素相同），更小才采用；16 位、动画 PNG（IDAT 前有 `acTL`）与超过 16383 像素的保持原样；
  - JPEG（照片）→ 按 EXIF 旋正 → 长边限制（默认 3072）→ 有损 WebP（默认质量 85）；节省不到 10% 时保留原图；
  - HEIC/HEIF → libheif 的 WASM 版（`heic-decode`，同一时间只解码一张）→ 有损 WebP；libheif 已按容器摆正，不再旋转。它不给出色彩配置，所以直接读 HEIF 容器的 `colr`：内嵌 ICC 照原样标注，nclx 标为 Display P3 时标注 sharp 内置的 P3 配置——只标注、不转换，照片不会“变淡”；
  - AVIF → sharp 解码 → 有损 WebP；GIF、WebP 保持原样；
  - 转换后的文件去掉全部元数据（含 GPS），只保留 ICC；任何时候都不做色彩转换；解码上限约 1 亿像素；
  - 只保存转换结果；原始输入记录里保留原文件的格式、大小与哈希（`raw_inputs.original_*`，只在存下的字节与收到的不同时填写），而不是原字节；
  - 失败时：可存储的格式按原样保存并记警告；只能输入的格式报 `UNSUPPORTED_MEDIA`。
  - 远程图片按原样逐字节保存（URL 本身就是来源凭据），只有 HEIC/AVIF 转换成 WebP。
- 附件写入顺序：写临时文件并刷盘 → 原子移动到 `assets/<sha[0:2]>/<sha>.<ext>` → 提交数据库记录。异常中断最多留下待清理的临时文件，不会出现指向不存在文件的记录。
- Markdown 中引用系统管理的附件统一写作 `assets/<asset-id>.<ext>`（`src/shared/assetRef.ts`），渲染时映射到 `/api/assets/<id>`，导出时对应导出包里的 `assets/` 目录。

## 远程图片

- 用户输入图片 URL 时立即尝试下载；保存 Markdown 时，服务端用 remark 语法树（与前端相同的 GFM + math 扩展）找出实际的图片节点，为其中的远程地址建立记录并在后台下载。代码块、行内代码和普通链接里的 URL 不会触发下载。
- **不改写 Markdown 源码**：源码里保留原 URL，显示时通过“URL → 本地附件”映射使用本地副本；未归档时只显示占位、原 URL 与失败原因，不回退到外链加载（页面 CSP 也只允许本机图片）。Markdown 导出时才把已归档的地址改写为相对路径。这样后台下载完成时不会与正在进行的编辑冲突。
- **下载器**（`services/remoteFetch.ts`）：只接受 http/https，拒绝带凭证的 URL；每一跳（含重定向）都重新解析并校验地址，只允许公网单播地址，并通过自定义 `lookup` 让实际连接使用已校验的地址（防 DNS 重绑定）；限制超时、重定向次数和大小，按文件头确认是图片。
- **fake-ip DNS**：有些网络或代理软件会把外部域名解析到保留段 `198.18.0.0/15`，默认策略会拒绝它们，并在错误信息中提示。启动参数 `--allow-fake-ip-dns` 只额外放行这一段。
- 下载失败保留 URL 与原因，可以重试或手动补传本地图片。

## 检索

用户写法见 [search-syntax.md](search-syntax.md)。所有条件都写在搜索框（地址栏的 `q`）里，导航点击、条件面板、小标签上的 × 都是改写这段文本（GitHub 式）。

- **查询语言**（`src/shared/query/`，前后端共用）：`tokenize.ts`（位置对应原文，全角与半角符号等价）→ `parse.ts`（带位置与诊断的语法树，不抛错；优先级 取反 > OR > 空格）→ `resolve.ts`（按目录把属性、选项、学生换成 ID，得到语义树；目录接口 `QueryCatalog` 前后端各自实现）。`serialize.ts` 按当前名称把语义树写回文本；`analyze.ts` 把顶层条件拆成面板的行、推出导航高亮与学生上下文；`edit.ts` 只改写某个条件的文本范围，不重排用户手打的文字。解析错误（未知选项、非法日期、对无序属性用比较符）编译为恒假并报错——打错字不会悄悄放宽结果；未知的键当普通文字并警告。
- **规范化**（`normalize.ts`）：逐码点 NFKC + 小写 + 折叠空白（含全角空格、换行），带到原文的位置映射。检索投影与查询词用同一个函数，SQL 里注册了同样的确定性函数 `sworks_norm()`（文本属性的子串匹配用）。
- **检索投影**（`services/search/index.ts`）：每个题目/资料保存时，把标题、内容块正文、图片说明、未删除笔记、标签名、属性取值（选项为完整路径）、来源备注按字段规范化后写入 `search_index`。规则变化时递增 `SEARCH_INDEX_VERSION`（记在 `library_meta.search_index_version`，运行时标记、不进备份），打开库时按需整体重建（日志“正在重建检索索引…”）。整体重建共用一份选项路径表（`properties.ts#optionIndex`）；批量操作与管理操作也是整批共用一份，逐个对象重读选项表在大库里会让一次改名卡住数秒。
- **编译**（`services/search/compile.ts`）：语义树 → 参数化 SQL，只拼接白名单里的表名与列名，所有值都绑定参数。每个叶子条件求值为 0/1、不会是 NULL，所以取反才正确（`-学科:数学` 包含未设置学科的对象）。文字条件是 `search_index` 上的 `instr()` 子串匹配（可限定字段）；标签、选项含子树。不使用 LIKE 通配。
- **列表查询**（`services/search/query.ts`）：查询文本与旧的筛选参数（`filtersToAst`）取“且”，一页一次查询（`COUNT(*) OVER ()`）。`sort` 省略时：有正向自由词按相关度，否则按创建时间；响应带 `sortApplied`、`diagnostics` 与学生上下文 `studentId`。相关度 = Σ 字段权重 × 命中的条件（标题 8、标签/属性 5、正文 3、答案/解析/笔记 2、其他 1；短语 ×2），排序 `score DESC, updated_at DESC`。
- **命中片段**（`services/search/snippets.ts`）：只为当前页生成：从原文取各字段文字 → 带位置映射规范化 → 找出正向文字条件的命中 → 每项最多 2 条（按字段权重 × 命中条件数，跳过标题）→ 前后各 36 字、折叠空白 → 高亮区间换算到片段文字。界面用 `<mark class="hit">` 显示。
- **常用检索**（`services/savedSearches.ts`，表 `saved_searches`）：保存语义树（属性/选项/学生用 ID，标签用路径，日期保存原样的写法所以“本周”一直是本周）与当时的文本；显示时按当前名称重新生成文本。标签改名/合并/删除、学科学段改名/合并、选项合并在同一事务里改写保存的条件（被合并的选项改指向合并目标）；失效的部分（选项、标签、学生已删除）在 `problems` 里给出提示。导航里带计数（`GET /api/saved-searches/counts`）。
- **性能**：不用 FTS5——trigram 对一两个字的中文词没有结果。预估约 1 万条（约 10 万行投影）单词 20–60ms、多条件 50–150ms；以后需要时可把 FTS5 作为 ≥3 字词的预筛选。

筛选参数的编解码只有一份（`src/shared/listFilters.ts`），地址栏与服务端共用。`q` 之外的旧参数（`tag=`、`tags=`、`untagged=1`、`subject=`、`stage=`、`prop=`、`student=`+`attempt=`）仍然有效，页面在目录加载后把它们转成查询文本；单独的 `student=` 只是“按学生查看”的上下文。`sort=created|updated|relevance|prop:<属性ID>`；`fields=ids` 同样的条件只返回 ID（“选择全部 N 项”）。

导航计数（`GET /api/nav`）按不重复的对象计算子树数量，避免同时带父子标签的对象被重复计数。

## 备份、恢复与导出

格式说明见 [backup-format.md](backup-format.md)。

- **备份**（`services/backup.ts`）：Backup API 一致快照 → 从快照导出逻辑记录（`backupFormat.ts` 的 `RECORD_TABLES`）→ 按快照清单读取附件并核对哈希 → 用 yazl 写临时 ZIP → 用与恢复相同的 `validateBackup` 完整校验 → 原子发布到 `backups/`。
- **恢复**（`services/restore.ts`，只通过命令行）：目标必须是新的空目录且未被占用 → 校验 ZIP（yauzl `strictFileNames`、条目白名单、拒绝符号链接与加密条目、数量与体积上限）、清单、记录与附件哈希 → 在目标旁的临时目录先建出与备份相同版本的库、写入记录（外键检查推迟到提交）、再按迁移链升级到当前版本 → 检查外键/数量/哈希/完整性、重建检索投影 → 全部通过后改名为目标目录。旧版本备份由此可以恢复。
- **Markdown 导出**（`services/exportMarkdown.ts`）：每题一个文件（YAML 元信息含标签与属性，层级选项写成路径，便于在 Obsidian 中阅读；不含学生与作答记录），普通文字块用比内容更长的反引号围栏包裹，只打包实际引用的图片，未归档图片保留原 URL 并在 README 中警告。它是开放阅读格式，不承诺无损回导。

## 安全模型

本机无登录，但不允许任意网页访问本地 API（`http/security.ts`）：

- **Host 校验**：只接受本机回环地址加实际端口，防 DNS 重绑定。
- **修改类请求**：Origin（如有）必须同源，`Sec-Fetch-Site`（如有）必须为同源，且必须携带 `x-sworks-csrf` 头。令牌在进程启动时随机生成，由 `GET /api/session` 下发；跨源页面既读不到令牌，也无法在不经预检的情况下发送自定义头。服务不返回任何 CORS 头，并拒绝预检请求。
- **GET 不修改数据**；附件读取只按 ID 查库并在受控目录内取文件，禁止路径穿越。
- **MCP**（`/mcp`，见 [mcp.md](mcp.md)）：鉴权只在 `security.ts` 的单独分支里——未启用时 404；带 `Origin` 或 `Sec-Fetch-Site` 不是 `none` 的请求（来自浏览器）一律 403；必须带正确的 Bearer 令牌（定长比较），否则 401。令牌在 `<数据目录>/mcp.json`（0600），不进备份。处理器是官方 SDK 的 `createMcpHandler`（无状态），工具由 `ops/` 生成，只读模式只注册读操作；写入在 `{kind:'mcp'}` 来源下运行。可选的 stdio 桥 `cli/mcp.ts` 读 `server.json` 与 `mcp.json`，把标准输入的 JSON-RPC 转发到 `/mcp`。
- **页面 CSP**：脚本、样式、字体、图片只来自本机；附件响应带 `nosniff` 与 `sandbox`。
- **Markdown 渲染**：不启用原始 HTML（以文字显示），链接协议受控，KaTeX 关闭 `trust`。
- 日志不记录笔记内容、图片内容或完整 URL。

## 前端

- **布局**（参照 Notebook Navigator 的“导航 + 列表”；只借鉴设计，不使用其 GPL 代码）：左侧导航面板 `components/NavPane.tsx` 列出库、学生、标签树、各属性的选项树与学科/学段，带计数；点节点即筛选当前列表，⌘/Ctrl+点击追加条件；把列表行拖到节点上即加标签或设置属性。编辑仍是独立页面。
- **列表**（`components/EntityList.tsx` 与 `components/list/`）：时间分组、属性与标签小标签、多选（勾选、Shift 连选、⌘/Ctrl+A、选择全部 N 项；筛选变化时清空）、批量操作栏（可撤销的操作在提示里给“撤销”）、右键菜单、空格快速预览、键盘导航（J/K、X、Enter、/、Esc）；返回列表时恢复滚动位置与焦点。
- **数据管理**（`pages/ManagePage.tsx`、`pages/PropertiesTab.tsx`）：标签、学科/学段与属性选项树共用 `components/manage/ManageTree.tsx`（headless-tree）：单击只选、⌘/Ctrl 切换、⇧ 连选、⌘/Ctrl+A、Esc；F2 或双击改名；Delete 删除所选；可拖动全部所选项。右键或每行的“⋯”打开同一菜单，作用于整个选择（右键未选中的项时先只选它）；父子同时选中时只处理父级。多项操作走服务端的 `*-many` / `merge` 接口，一个请求一个事务，被多个所选项命中的对象只递增一次版本。会改动题目内容的管理操作（删除、合并、改名或移动标签，清除或合并学科学段，删除或合并选项，清理未使用的标签）在提示里给“撤销”：服务端在操作的事务里记下受影响行操作前后的样子（`services/undoJournal.ts`，只在进程内存里保留 30 分钟、最多 20 份），撤销（`POST /api/undo/:id`，`services/undo.ts`）时先确认这些行仍与操作刚结束时一样，再换回操作前的样子并递增受影响对象的版本；期间有过修改、或新建了同名的标签/选项时拒绝，不覆盖之后的修改。属性列表也有右键菜单（编辑选项、改名、在左侧栏列出、上移/下移、归档）。左侧导航里属性、标签、学科学段的分组标题右键可以直接到数据管理（`/manage?item=<属性ID|tags|subject|stage>`），属性还可以“不在左侧栏列出”。操作说明收在各处的“?”弹出层里（`components/manage/ManageHelp.tsx`）。注意 headless-tree 在渲染中按引用比较受控的 `expandedItems`/`selectedItems`，内容不变时必须传同一个数组，否则会无限重渲染。
- **数据与缓存**：列表、导航计数、字典、属性、学生用 TanStack Query 缓存；写入成功后 `invalidateWrites()` 使缓存失效，并通过 BroadcastChannel 通知同一浏览器的其他标签页；其他浏览器、MCP 与后台任务的写入经服务端推送（见“变更事件与操作”）到达。其他标签页里打开着的编辑页：没有未保存修改时自动刷新，有未保存修改时提前提示“已在别处修改”。编辑页的整份草稿不走缓存。
- **搜索框**（`components/search/`）：`QueryInput.tsx` 是单行 CodeMirror（按分词结果高亮，字段条件显示成小标签并带 ×；`@codemirror/autocomplete` 补全键名与取值；`@codemirror/lint` 显示按缓存目录解析出的问题；停顿 300ms 或回车提交）；`ConditionPanel.tsx` 是同一段文本的面板视图（每个顶层条件一行，复杂条件只读，可“在文本中编辑”；自由词范围；保存为常用检索；语法速查）。导航树点击经 `edit.ts` 改写文本，高亮由 `analyze.ts` 推出；`lib/queryText.ts` 把缓存的目录转成查询目录。
- **组件库**：菜单、右键菜单、弹出层用 Radix；命令面板与可搜索选择器用 cmdk（放在现有的原生 `<dialog>` 里，全站只有一套对话框）；导航树与选项树编辑用 headless-tree（键盘、拖拽、重命名）。快捷键判断统一在 `lib/hotkeys.ts`（输入框、CodeMirror、输入法组字与打开的弹层内不触发）。
- **路由**：`lib/router.tsx` 基于 History API，带未保存修改的离开确认（`useLeaveGuard`，同时处理关闭/刷新页面）。页面路由在 `App.tsx`。新建页的 URL 带着 ID，首次保存后把地址替换为 `/problems/<id>`，由于 React key 不变，页面不会重新挂载。
- **编辑状态**：`lib/useEntityEditor.ts` 由题目页和资料页共用，负责加载、草稿、未保存判断（比较 `lib/draft.ts` 生成的规范化载荷）、带版本的保存、冲突状态，以及轮询归档中的远程图片。只有服务端返回成功后才显示“已保存”；失败时草稿保持不变。
- **笔记**：`components/NotesEditor.tsx` 按“笔记 / 解析 / 答案”分栏（`components/Tabs.tsx`），栏内用拖动手柄排序（dnd-kit，键盘可操作：空格拿起、方向键移动、空格放下）。草稿中所有笔记仍是一个数组，保存时数组下标即 `position`；栏内的拖动、填序号后的自动归位与“按序号重排”都只在该类型已占用的位置之间重排（`lib/noteOrder.ts`），其他类型原位不动。序号只作标注与归位依据，拖动后允许与顺序不一致。保存请求里省略 `seq` 表示保留原值（升级前仍开着的旧页面不会抹掉序号），`null` 表示清除。快速预览同样分栏，列表项命中答案/解析/笔记时默认打开对应栏。Markdown 导出按类型分节，带序号的标题写成“解析 (1)：标题”。
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
- 只能恢复到新的空目录，不支持合并到已有库；旧版本备份（v1–v3）经迁移链恢复。
- 学科、学段仍是题目上的内置文本列，不属于属性系统；界面上与属性一样展示与筛选。
- 复习提醒（间隔重复）尚未接入；作答流水已按 revlog 形式保存，可以在不改库的情况下用 ts-fsrs 推算。
- 测试只覆盖 Linux + Chromium。
