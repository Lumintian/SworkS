/** 运行中的服务写在数据目录里的信息（server.json），供命令行工具（例如 MCP stdio 桥）找到它。 */
import path from 'node:path';

export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  bootId: string;
  startedAt: string;
  appVersion: string;
}

export const SERVER_INFO_FILE = 'server.json';

export function serverInfoPath(dataRoot: string): string {
  return path.join(dataRoot, SERVER_INFO_FILE);
}
