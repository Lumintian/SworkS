#!/usr/bin/env node
// 开发模式：后端（tsx watch，不提供页面）+ Vite 开发服务器（热更新，/api 代理到后端）。
// 普通使用请用 pnpm build && pnpm start。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = process.env.SWORKS_DEV_API_PORT ?? '4822';
const dataDir = process.env.SWORKS_DATA_DIR ?? path.join(root, 'sworks-dev-data');
// 直接用 node 运行各工具的 JS 入口，避免 Windows 上 .bin/*.cmd 需要 shell 的问题
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const children = [
  spawn(process.execPath, [tsxCli, 'watch', 'src/server/cli/start.ts', '--data-dir', dataDir, '--port', apiPort, '--no-web', '--dev-origin', 'http://127.0.0.1:5173', '--dev-origin', 'http://localhost:5173'], {
    cwd: root,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [viteCli], { cwd: root, stdio: 'inherit', env: { ...process.env, SWORKS_DEV_API_PORT: apiPort } }),
];
console.log(`开发模式：页面 http://127.0.0.1:5173 ，API 端口 ${apiPort}，数据目录 ${dataDir}`);
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => code && stop());
