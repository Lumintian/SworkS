# 插件（设计）

> 本轮只确定接口：类型在 `src/server/plugins/api.ts`，示例插件在 `tests/fixtures/plugins/example/`（两者都参与 `pnpm typecheck`）。加载、任务队列与设置页在下一轮实现。

插件让 SworkS 接上老师自己选择的工具，首批场景是：

- **AI / OCR**：把题图交给模型识别成文字、写解析、按考点打标签；
- **后台定时任务**：定时完整备份、定期整理。

SworkS 不内置任何模型或 API 密钥；模型调用写在插件自己的代码里。

## 能力面：与 MCP 相同

插件不直接访问数据库，只能调用操作注册表（`src/server/ops/`）里的操作——与 MCP 工具完全相同的一组能力（见 [mcp.md](mcp.md)）：

- `api.ops.invoke('add_note', { … })`：内置操作带类型（操作名、输入、输出都由注册表推出，写错会在编译时报错）；
- 写入全部经整体保存：递增版本、重建检索索引，带 `expectedVersion` 时版本不符返回冲突，不会覆盖老师刚在页面上的修改；
- 写入的来源是 `{kind:'plugin', pluginId, taskId}`，经服务端推送即时刷新打开着的页面，事件里能看出是哪个插件改的；
- `api.assets.readForModel(id)` 把题图缩小到长边 1568 像素、转成 PNG，直接交给模型。

## 加载

- 位置：`<数据目录>/plugins/<id>/`。入口由 `package.json` 的 `"sworks"` 字段指定（`PluginManifest`：`apiVersion`、`id`、`name`、`version`、`entry`），没有时用目录里的 `index.ts` 或 `index.js`，id 取目录名。
- TypeScript 用 Node 24 的原生类型擦除直接加载，所以只支持可擦除的语法（不支持 `enum`、`namespace`、参数属性等），也不做打包；需要依赖时插件自带 `node_modules`。
- **默认全部关闭**。`<数据目录>/plugins.json` 是启用清单（`{ "enabled": ["example-ocr"] }`），在设置页里勾选。启动参数 `--safe-mode` 忽略清单、不加载任何插件，用于排查问题。
- 生命周期：服务开始监听之后按清单顺序调用 `activate(api)`；关闭前调用 `deactivate()`（最多等 5 秒）。启用、停用或更新插件后需要重启服务。

## 信任模型

插件与 SworkS 在同一个进程里运行，**拥有与 SworkS 相同的权限**（能读写文件、访问网络）。“只经操作注册表写题库”是为了保证数据一致，而不是安全隔离。所以：

- 只安装自己信任的插件，默认全部关闭；
- 设置页显示每个插件的来源目录与版本；
- 插件的设置与数据放在 `<数据目录>/plugin-data/<id>/`（`settings.json` 等），**不进备份**——里面可能有 API 密钥。

## 错误隔离

- 钩子（`api.on(…)`）在写入**提交之后**异步调用，处理器各自捕获异常：失败只记日志，永远不会阻塞、回滚或改写老师的保存。
- 钩子必须很快返回；耗时工作用 `h.enqueue(name, run)` 放进任务队列。
- `activate` 抛错时这个插件被标为“加载失败”（设置页显示原因），其他插件与 SworkS 照常工作。
- 插件注册的 MCP 工具名是 `<id>__<name>`；内置操作名里没有 `__`，不会冲突。

## 任务队列

- 内存中的先进先出队列：全局并发 2，每个插件并发 1。服务重启后未完成的任务不补跑。
- 任务状态（`TaskInfo`：排队、运行、成功、失败、取消，进度与错误）经 SSE 推送为 `task.updated` 事件；`GET /api/tasks` 列出最近的任务，`POST /api/tasks/:id/cancel` 取消（通过 `TaskContext.signal` 通知插件）。
- 插件的命令（`registerCommand`）出现在命令面板与题目/资料的右键菜单里，作用于所选对象；定时任务（`registerJob`）按 `everyMinutes` 或 cron 表达式执行，也可以设为只手动触发。

## 示例

`tests/fixtures/plugins/example/index.ts`：

- 命令“识别题图文字”：`get_problem` → 每个图片块 `assets.readForModel` → 插件自己调用识别服务 → `add_note`（带 `expectedVersion`）；
- 同一功能注册为工具 `example-ocr__ocr_problem`，MCP 客户端也能调用；
- 钩子 `rawInputs.created`：新收录图片时放进任务队列；
- 定时任务：每天 `create_backup`。

OCR 的完整流程：`on('rawInputs.created')` → `enqueue` → `assets.readForModel` → 插件调用模型 → `ops.invoke('add_note', { type: 'solution', … })` / `set_properties` / `add_tags`。写入全部经整体保存，版本、检索索引、冲突检测等不变量照常成立。
