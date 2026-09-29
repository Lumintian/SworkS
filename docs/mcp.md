# MCP 接入

SworkS 可以作为 [MCP](https://modelcontextprotocol.io) 服务器，让本机的 AI 助手（例如 Claude Code）检索题库、查看题图，并在允许时写解析、打标签、设置题型与考点。

## 启用

1. 启动 SworkS（`pnpm start`），打开“设置 → MCP”，勾选“启用 MCP”。
2. 选择权限：
   - **只读**（默认）：检索、读取题目与资料、查看题图、列出属性/标签/学生/常用检索；
   - **可写**：另外可以新建题目、整体保存题目、加笔记/解析/答案、按名称设置属性、加减标签、记录作答、把题目移到回收站（可在回收站恢复）。
3. 复制页面上的命令或配置片段。

### Claude Code

```bash
claude mcp add --transport http sworks http://127.0.0.1:4822/mcp --header "Authorization: Bearer <令牌>"
```

端口以“数据目录与运行信息”页显示的访问地址为准（默认 4822）。

### 只支持 stdio 的客户端

用自带的 stdio 桥（需要 SworkS 服务在运行）：

```json
{
  "mcpServers": {
    "sworks": { "command": "pnpm", "args": ["--dir", "<SworkS 程序目录>", "mcp", "--", "--data-dir", "<数据目录>"] }
  }
}
```

桥从数据目录读取运行中服务的地址（`server.json`，服务启动时写入、退出时删除）与令牌（`mcp.json`），把标准输入的每行 JSON-RPC 转发到 `/mcp`。服务没有运行或 MCP 未启用时，它在标准错误输出里说明原因并退出。

## 工具

工具由服务端的操作注册表生成（`src/server/ops/`），说明都是中文，写给模型看：

| 工具 | 权限 | 作用 |
| --- | --- | --- |
| `search` | 读 | 检索题目或资料，查询语法与页面搜索框相同（见 [search-syntax.md](search-syntax.md)），返回摘要、命中字段与命中片段 |
| `get_problem`、`get_material` | 读 | 读取全文（内容块、笔记、标签、属性、版本号） |
| `get_asset_image` | 读 | 读取题图，缩小到长边 1568 像素以内，作为图片内容返回 |
| `list_properties`、`list_tags`、`list_students`、`list_saved_searches` | 读 | 目录 |
| `create_problem` | 写 | 新建题目（Markdown 题干、已有图片附件、标签、按名称的属性）；带 `id` 时重试不会重复 |
| `update_problem` | 写 | 整体保存（需要 `expectedVersion`） |
| `add_note`、`update_note` | 写 | 笔记、解析、答案（可带序号） |
| `set_properties` | 写 | 按名称与选项路径设置属性，可 `createMissingOptions` |
| `add_tags`、`remove_tags`、`ensure_option_path`、`record_attempt` | 写 | |
| `create_backup` | 写 | 立即做一次完整备份（不改动题库内容） |
| `trash_problem` | 破坏性 | 移到回收站（可恢复） |

写操作都走与页面相同的整体保存：递增版本、重建检索索引；带 `expectedVersion` 且版本不符时返回冲突，不会覆盖老师刚在页面上的修改。AI 的写入会立即出现在打开着的页面上（服务端推送）；有未保存修改的编辑页会提示“已在别处修改”。

## 安全模型

- 服务只监听 `127.0.0.1`；`/mcp` 同样校验 Host（防 DNS 重绑定）。
- `/mcp` 只给本机的命令行客户端用：带任何 `Origin` 头，或 `Sec-Fetch-Site` 不是 `none`（即来自浏览器）的请求一律拒绝；不返回 CORS 头，拒绝预检请求。
- 必须带 `Authorization: Bearer <令牌>`，令牌为 32 字节随机数，按定长比较；未启用时 `/mcp` 返回 404。
- 令牌保存在 `<数据目录>/mcp.json`（权限 0600），不进备份；可以在设置页随时重新生成，旧令牌立即失效。
- 只读模式下写工具根本不会注册；即使直接调用也会被拒绝。
- MCP 的请求体上限 4 MiB。
