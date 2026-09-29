/**
 * MCP 设置：`<数据目录>/mcp.json {enabled, mode, token}`（0600）。
 * 令牌只属于这台机器上的这个数据目录，不进备份（所以不放在 library_meta 里）；可随时重新生成。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../fsutil.js';
import type { DataPaths } from '../paths.js';

export const MCP_CONFIG_FILE = 'mcp.json';

export const mcpConfigSchema = z.object({
  enabled: z.boolean(),
  /** read：只注册读操作；write：也允许写入（含移到回收站） */
  mode: z.enum(['read', 'write']),
  /** 64 位十六进制（32 字节）；未启用过时为空 */
  token: z.string().regex(/^([0-9a-f]{64})?$/),
});
export type McpConfig = z.infer<typeof mcpConfigSchema>;

export const DEFAULT_MCP_CONFIG: McpConfig = { enabled: false, mode: 'read', token: '' };

export function mcpConfigPath(root: string): string {
  return path.join(root, MCP_CONFIG_FILE);
}

export function newMcpToken(): string {
  return randomBytes(32).toString('hex');
}

/** 读取设置；文件不存在或损坏时视为未启用（不自动改写文件）。 */
export function loadMcpConfig(root: string): McpConfig {
  try {
    const r = mcpConfigSchema.safeParse(JSON.parse(fs.readFileSync(mcpConfigPath(root), 'utf8')));
    return r.success ? r.data : { ...DEFAULT_MCP_CONFIG };
  } catch {
    return { ...DEFAULT_MCP_CONFIG };
  }
}

export async function saveMcpConfig(paths: DataPaths, cfg: McpConfig): Promise<void> {
  await writeFileAtomic(mcpConfigPath(paths.root), `${JSON.stringify(cfg, null, 2)}\n`, paths.tmp, 0o600);
}
