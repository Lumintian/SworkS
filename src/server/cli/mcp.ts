#!/usr/bin/env node
/**
 * MCP 的 stdio 桥：给只支持 stdio 的 MCP 客户端用（Claude Code 等可以直接连 HTTP，不需要它）。
 * 从数据目录读出运行中服务的地址（server.json）与令牌（mcp.json），
 * 把标准输入的每一行 JSON-RPC 原样 POST 到 /mcp，把结果逐行写回标准输出。
 * 所有提示都写到标准错误，标准输出只留给协议消息。
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { APP_VERSION } from '../../shared/constants.js';
import { loadMcpConfig } from '../mcp/config.js';
import { resolveDataDir } from '../paths.js';
import { serverInfoPath, type ServerInfo } from '../serverInfo.js';

const HELP = `SworkS ${APP_VERSION} — MCP stdio 桥

用法（先启动 SworkS 服务，并在“设置 → MCP”里启用）：
  pnpm mcp -- --data-dir <数据目录>
`;

const err = (m: string) => process.stderr.write(`[sworks-mcp] ${m}\n`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readServerInfo(root: string): ServerInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(serverInfoPath(root), 'utf8')) as ServerInfo;
    return info.url && alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

/** 把一次 HTTP 响应里的 JSON-RPC 消息（JSON 或 SSE）逐条写到标准输出 */
async function relay(res: Response): Promise<void> {
  const type = res.headers.get('content-type') ?? '';
  if (res.status === 202 || res.status === 204) return;
  const text = await res.text();
  if (!text.trim()) return;
  if (type.includes('text/event-stream')) {
    for (const block of text.split(/\n\n/)) {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) process.stdout.write(`${data}\n`);
    }
    return;
  }
  process.stdout.write(`${text.trim()}\n`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { 'data-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (values.help) {
    process.stderr.write(HELP);
    return 0;
  }
  const root = resolveDataDir(values['data-dir']);
  const info = readServerInfo(root);
  if (!info) {
    err(`没有找到运行中的 SworkS 服务（${serverInfoPath(root)}）。请先用 pnpm start 启动服务。`);
    return 1;
  }
  const cfg = loadMcpConfig(root);
  if (!cfg.enabled || !cfg.token) {
    err('MCP 未启用：请在 SworkS 的“设置 → MCP”里打开。');
    return 1;
  }
  err(`已连接 ${info.url}/mcp（${cfg.mode === 'write' ? '可写' : '只读'}）`);
  let protocolVersion: string | null = null;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // 按顺序转发，保证响应顺序与请求一致
  let chain = Promise.resolve();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    chain = chain.then(async () => {
      let msg: { id?: unknown; method?: string } | null = null;
      try {
        msg = JSON.parse(trimmed) as { id?: unknown; method?: string };
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        return;
      }
      try {
        const res = await fetch(`${info.url}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${cfg.token}`,
            ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
          },
          body: trimmed,
        });
        if (msg.method === 'initialize' && res.ok) {
          const clone = res.clone();
          await relay(res);
          const text = await clone.text();
          const m = /"protocolVersion"\s*:\s*"([^"]+)"/.exec(text);
          if (m) protocolVersion = m[1]!;
          return;
        }
        if (!res.ok && res.status !== 202) {
          const body = await res.text();
          err(`HTTP ${res.status}：${body.slice(0, 200)}`);
          if (msg.id !== undefined) {
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `SworkS 返回 HTTP ${res.status}` } })}\n`);
          }
          return;
        }
        await relay(res);
      } catch (e) {
        err(`无法连接 SworkS：${(e as Error).message}`);
        if (msg.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: '无法连接 SworkS 服务' } })}\n`);
      }
    });
  }
  await chain;
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    err((e as Error).message);
    process.exitCode = 1;
  },
);
