/** MCP：在设置页启用 → 客户端写入即时出现在打开着的页面上；stdio 桥作为子进程转发。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { expect, test } from '@playwright/test';
import { apiGet, ROOT, startServer, tempDir, type Server } from './helpers';

let server: Server | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function mcpCall(s: Server, token: string, method: string, params: unknown) {
  const res = await fetch(`${s.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
  return json.result;
}

test('设置页启用 MCP；MCP 写入经服务端推送即时刷新打开着的列表与编辑页', async ({ page, context }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  await page.goto(`${server.url}/settings`);
  await page.getByLabel('启用 MCP').check();
  await expect(page.getByText('已启用 MCP')).toBeVisible();
  await page.getByLabel(/可写/).check();
  await expect(page.getByText('已允许写入')).toBeVisible();
  const command = await page.getByTestId('mcp-claude-command').textContent();
  const token = /Bearer ([0-9a-f]{64})/.exec(command ?? '')![1]!;
  expect(command).toContain(`claude mcp add --transport http sworks ${server.url}/mcp`);

  // 打开列表页与一个编辑页（没有未保存修改）
  const created = JSON.parse((await mcpCall(server, token, 'tools/call', { name: 'create_problem', arguments: { title: '对勾函数', markdown: '求 $x+1/x$ 的最小值' } })).content[0].text);
  const list = await context.newPage();
  await list.goto(`${server.url}/problems`);
  await expect(list.getByTestId('list-item')).toHaveCount(1);
  await page.goto(`${server.url}/problems/${created.id}`);
  const tabs = page.getByRole('tablist', { name: '笔记类型' });
  await expect(tabs.getByRole('tab', { name: /^解析/ })).toContainText('0');

  // AI 写解析 → 编辑页的解析栏即时出现；AI 新建题目 → 列表即时多一项
  await mcpCall(server, token, 'tools/call', { name: 'add_note', arguments: { problemId: created.id, type: 'solution', bodyMd: '由均值不等式，最小值为 2' } });
  await expect(tabs.getByRole('tab', { name: /^解析/ })).toContainText('1');
  await mcpCall(server, token, 'tools/call', { name: 'create_problem', arguments: { markdown: '第二道题' } });
  await expect(list.getByTestId('list-item')).toHaveCount(2);
  expect((await apiGet(server, `/api/problems/${created.id}`)).version).toBe(2);
});

test('stdio 桥：以子进程转发 initialize 与 tools/list；服务未运行时给出明确提示', async ({ page }) => {
  const dataDir = path.join(tempDir(), 'data');
  server = await startServer(dataDir);
  await page.goto(`${server.url}/settings`);
  await page.getByLabel('启用 MCP').check();
  await expect(page.getByText('已启用 MCP')).toBeVisible();

  const bridge = spawn(process.execPath, ['dist/node/server/cli/mcp.js', '--data-dir', dataDir], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: bridge.stdout! });
  const received: unknown[] = [];
  lines.on('line', (l) => received.push(JSON.parse(l)));
  bridge.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } })}\n`);
  bridge.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  bridge.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  await expect.poll(() => received.length, { timeout: 10_000 }).toBe(2);
  expect(received[0]).toMatchObject({ id: 1, result: { serverInfo: { name: 'sworks' } } });
  const tools = (received[1] as { id: number; result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  expect(tools).toContain('search');
  // 默认只读：没有写工具
  expect(tools).not.toContain('add_note');
  bridge.stdin!.end();
  await new Promise((r) => bridge.once('exit', r));

  // 服务停止后：server.json 已删除，桥明确提示并以非零状态退出
  await server.stop();
  server = undefined;
  expect(fs.existsSync(path.join(dataDir, 'server.json'))).toBe(false);
  const down = spawn(process.execPath, ['dist/node/server/cli/mcp.js', '--data-dir', dataDir], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  down.stderr!.on('data', (d) => (err += String(d)));
  const code = await new Promise((r) => down.once('exit', r));
  expect(code).toBe(1);
  expect(err).toContain('没有找到运行中的 SworkS 服务');
});
