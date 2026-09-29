import fs from 'node:fs';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpConfigPath } from '../../src/server/mcp/config.js';
import { makeTestApp, newId, uploadImage, type TestApp } from '../helpers/server.js';
import { readSse } from '../helpers/sse.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

const PROTOCOL = '2025-06-18';

async function enable(app: TestApp, mode: 'read' | 'write' = 'write') {
  const r = await app.json('POST', '/api/mcp', { enabled: true, mode });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

/** 发一条 JSON-RPC 请求，返回解析后的响应（服务端可能用 SSE 或 JSON 回应） */
async function rpc(app: TestApp, token: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  const res = await app.raw('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL,
    ...headers,
  });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, body: text ? JSON.parse(text) : null };
  const json = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6))
    : JSON.parse(text);
  return { status: res.status, body: json };
}

async function callTool(app: TestApp, token: string, name: string, args: unknown) {
  const r = await rpc(app, token, 'tools/call', { name, arguments: args });
  expect(r.status).toBe(200);
  const result = r.body.result as { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] };
  return { ...result, json: () => JSON.parse(result.content[0]!.text!) };
}

describe('MCP 接入', () => {
  it('未启用时 404；启用后令牌写入 mcp.json（0600），可以重新生成', async () => {
    t = await makeTestApp();
    const off = await t.raw('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer x' });
    expect(off.status).toBe(404);
    const token = await enable(t);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const file = mcpConfigPath(t.lib.paths.root);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ enabled: true, mode: 'write', token });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = (await t.json('POST', '/api/mcp', { regenerateToken: true })).body;
    expect(again.token).not.toBe(token);
    expect(again.claudeCommand).toContain(`Authorization: Bearer ${again.token}`);
    expect((await rpc(t, token, 'tools/list')).status).toBe(401);
    // 设置接口本身受 CSRF 保护
    expect((await t.raw('POST', '/api/mcp', { enabled: false })).status).toBe(403);
  });

  it('鉴权：缺少或错误的令牌 401；带 Origin（网页）或 Sec-Fetch-Site 403；非本机 Host 403；不返回 CORS 头', async () => {
    t = await makeTestApp();
    const token = await enable(t);
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const noAuth = await t.raw('POST', '/mcp', body);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toContain('Bearer');
    expect((await t.raw('POST', '/mcp', body, { authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401);
    expect((await t.raw('POST', '/mcp', body, { authorization: `Bearer ${token}`, origin: 'http://127.0.0.1:4821' })).status).toBe(403);
    expect((await t.raw('POST', '/mcp', body, { authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await t.raw('POST', '/mcp', body, { authorization: `Bearer ${token}`, host: 'evil.example:4821' })).status).toBe(403);
    expect((await t.raw('OPTIONS', '/mcp', undefined, { authorization: `Bearer ${token}` })).status).toBe(403);
    const ok = await rpc(t, token, 'tools/list');
    expect(ok.status).toBe(200);
  });

  it('只读模式只列出读操作；可写模式包含写入与移到回收站', async () => {
    t = await makeTestApp();
    const token = await enable(t, 'read');
    const readTools = ((await rpc(t, token, 'tools/list')).body.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[]);
    expect(readTools.map((x) => x.name)).toEqual(expect.arrayContaining(['search', 'get_problem', 'get_asset_image', 'list_saved_searches']));
    expect(readTools.every((x) => x.annotations.readOnlyHint)).toBe(true);
    expect(readTools.some((x) => x.name === 'add_note')).toBe(false);
    await t.json('POST', '/api/mcp', { mode: 'write' });
    const all = ((await rpc(t, token, 'tools/list')).body.result.tools as { name: string; annotations: { destructiveHint: boolean } }[]);
    expect(all.find((x) => x.name === 'trash_problem')!.annotations.destructiveHint).toBe(true);
    expect(all.some((x) => x.name === 'add_note')).toBe(true);
  });

  it('add_note 递增版本、重建检索投影，并发出 mcp 来源的事件；search 用查询语言', async () => {
    t = await makeTestApp();
    const token = await enable(t);
    const created = (await callTool(t, token, 'create_problem', { markdown: '求函数 $f(x)=x+1/x$ 的最小值', tags: ['函数/最值'] })).json();
    await new Promise((r) => setImmediate(r));
    const sse = readSse(await t.request('GET', '/api/events'));
    await sse.next((e) => e.event === 'hello');
    const r = (await callTool(t, token, 'add_note', { problemId: created.id, type: 'solution', bodyMd: '用对勾函数的性质' })).json();
    expect(r).toMatchObject({ id: created.id, version: 2, changed: true });
    const ev = JSON.parse((await sse.next((e) => e.event === 'change')).data);
    expect(ev).toMatchObject({ type: 'entities.changed', problems: [{ id: created.id, version: 2 }], origin: { kind: 'mcp' } });
    await sse.close();
    const found = (await callTool(t, token, 'search', { query: '对勾 #函数' })).json();
    expect(found.items.map((i: { id: string }) => i.id)).toEqual([created.id]);
    expect(found.items[0].snippets[0].text).toContain('对勾');
    const bad = (await callTool(t, token, 'search', { query: '题型:不存在' })).json();
    expect(bad.total).toBe(0);
    expect(bad.diagnostics[0]).toMatchObject({ severity: 'error', text: '不存在' });
  });

  it('set_properties 可以按路径自动新建选项；错误以 isError 返回而不是协议错误', async () => {
    t = await makeTestApp();
    const token = await enable(t);
    const { id } = (await callTool(t, token, 'create_problem', { markdown: 'Choose the best answer.' })).json();
    const r = await callTool(t, token, 'set_properties', { problemId: id, values: [{ property: '题型', value: '英语/完型填空' }], createMissingOptions: true });
    expect(r.isError).toBeFalsy();
    const defs = (await t.json('GET', '/api/properties')).body as { preset: string; options: { path: string }[] }[];
    expect(defs.find((d) => d.preset === 'qtype')!.options.some((o) => o.path === '英语/完型填空')).toBe(true);
    const conflict = await callTool(t, token, 'add_tags', { problemId: id, expectedVersion: 1, tags: ['x'] });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]!.text).toContain('CONFLICT');
  });

  it('get_asset_image 返回缩小后的图片内容', async () => {
    t = await makeTestApp();
    const token = await enable(t, 'read');
    const png = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#9ab' } }).png().toBuffer();
    const up = await uploadImage(t, png, 'wide.png');
    const r = await callTool(t, token, 'get_asset_image', { id: up.asset.id });
    const img = r.content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    const meta = await sharp(Buffer.from(img.data!, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([1568, 523]);
    const missing = await callTool(t, token, 'get_asset_image', { id: newId() });
    expect(missing.isError).toBe(true);
  });
});
