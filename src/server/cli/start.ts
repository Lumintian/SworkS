#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '../config.js';
import { APP_VERSION } from '../../shared/constants.js';
import { consoleLogger } from '../context.js';
import { AppError } from '../errors.js';
import { resolveDataDir, webDistDir } from '../paths.js';
import { startServer } from '../server.js';

const HELP = `SworkS ${APP_VERSION} — 本地家教工作台（收题、整理、学生作答）

用法：
  pnpm start -- [--data-dir <目录>] [--port <端口>]

选项：
  --data-dir  数据目录。未指定时依次使用环境变量 SWORKS_DATA_DIR、<程序目录>/sworks-data
  --port      监听端口（默认 ${DEFAULT_PORT}），服务只绑定 127.0.0.1
  --allow-fake-ip-dns
              下载远程图片时额外允许 198.18.0.0/15。仅当所在网络或代理软件使用 fake-ip
              DNS（外部域名被解析到该段）时才需要；开启后，若该 DNS 也把内网域名映射到该段，
              远程图片下载可能间接访问内网，请知悉此风险。
  -h, --help  显示帮助
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      'data-dir': { type: 'string' },
      port: { type: 'string' },
      'dev-origin': { type: 'string', multiple: true },
      'no-web': { type: 'boolean' },
      'allow-fake-ip-dns': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const port = values.port ? Number(values.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`无效端口：${values.port}`);
  const dataDir = resolveDataDir(values['data-dir']);
  const running = await startServer({
    dataDir,
    port,
    webDir: values['no-web'] ? null : webDistDir(),
    log: consoleLogger,
    extraOrigins: values['dev-origin'] ?? [],
    ...(values['allow-fake-ip-dns'] ? { fetchPolicy: { allowFakeIpRange: true } } : {}),
  });
  const { migration } = running.library;
  console.log(`SworkS ${APP_VERSION} 已启动`);
  console.log(`  访问地址：${running.url}`);
  console.log(`  数据目录：${running.library.paths.root}`);
  console.log(`  数据库：  schema v${migration.to}${running.library.state === 'new' ? '（新建空库）' : ''}`);
  if (migration.safetyBackup) {
    console.log(`  已从 v${migration.from} 升级，升级前安全备份：${migration.safetyBackup}`);
  }
  if (values['allow-fake-ip-dns']) console.log('  远程图片：已额外允许 198.18.0.0/15（fake-ip DNS）');
  console.log('  按 Ctrl+C 停止服务');
  const shutdown = (signal: string) => {
    console.log(`\n收到 ${signal}，正在停止…`);
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const msg = err instanceof AppError || err instanceof Error ? err.message : String(err);
  console.error(`启动失败：${msg}`);
  process.exit(1);
});
