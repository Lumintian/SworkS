/**
 * MCP 服务：工具由操作注册表生成（名称、中文说明、zod 输入、只读/破坏性标注）。
 * 只读模式只注册读操作。每个请求建一个无状态的服务实例（stateless 模式）。
 */
import { createMcpHandler, McpServer, type CallToolResult, type McpHttpHandler } from '@modelcontextprotocol/server';
import { APP_VERSION } from '../../shared/constants.js';
import type { AppContext } from '../context.js';
import { toAppError } from '../errors.js';
import { isOpImage } from '../ops/assets.js';
import { ensureOpsRegistered, invokeOp, listOps, type Caller } from '../ops/index.js';

const INSTRUCTIONS = [
  'SworkS 是一位家教老师的本机题库：题目（题干、笔记/解析/答案、标签、题型/难度/考点等属性）、资料与学生作答记录。',
  '先用 search（查询语法见其说明）或 list_properties / list_tags 了解现有内容，再用 get_problem 读取全文、get_asset_image 查看题图。',
  '写入时优先用局部操作（add_note、set_properties、add_tags），它们会保留题目其余内容；属性与选项按名称和路径指定。',
  '所有写入都会记录版本；带 expectedVersion 可以避免覆盖老师刚刚在页面上的修改。',
].join('\n');

function toResult(value: unknown): CallToolResult {
  if (isOpImage(value)) {
    return {
      content: [
        { type: 'image', data: value.data, mimeType: value.mimeType },
        { type: 'text', text: `图片 ${value.width}×${value.height}` },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function buildMcpServer(ctx: AppContext, caller: Caller): McpServer {
  ensureOpsRegistered();
  const server = new McpServer({ name: 'sworks', title: 'SworkS 家教工作台', version: APP_VERSION }, { instructions: INSTRUCTIONS });
  for (const op of listOps({ readOnly: caller.readOnly ?? false })) {
    server.registerTool(
      op.name,
      {
        title: op.title,
        description: op.description,
        inputSchema: op.input,
        annotations: {
          title: op.title,
          readOnlyHint: op.access === 'read',
          destructiveHint: op.access === 'destructive',
          idempotentHint: op.idempotent ?? op.access === 'read',
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          return toResult(await invokeOp(ctx, op.name, args, caller));
        } catch (err) {
          const e = toAppError(err);
          if (e.status >= 500) ctx.log.error(`[MCP ${op.name}] ${e.code} ${e.message}`);
          return { isError: true, content: [{ type: 'text', text: `${e.code}：${e.message}${e.details !== undefined ? `\n${JSON.stringify(e.details)}` : ''}` }] };
        }
      },
    );
  }
  return server;
}

/** /mcp 的请求处理器（按当前模式构造调用方）。 */
export function createSworksMcpHandler(ctx: AppContext): McpHttpHandler {
  return createMcpHandler(() => buildMcpServer(ctx, { origin: { kind: 'mcp' }, readOnly: ctx.mcp.mode !== 'write' }), {
    legacy: 'stateless',
    onerror: (err) => ctx.log.warn(`MCP：${err.message}`),
  });
}
