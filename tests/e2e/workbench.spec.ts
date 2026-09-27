/** 家教工作台的整理交互：导航树筛选、多选与批量操作、命令面板、快速预览、数据管理。 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiGet, startServer, tempDir, type Server } from './helpers';

let server: Server | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function apiSend(s: Server, method: string, url: string, body: unknown) {
  const session = (await apiGet(s, '/api/session')) as { csrfToken: string };
  const res = await fetch(`${s.url}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-sworks-csrf': session.csrfToken, origin: s.url },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function seed(s: Server, title: string, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const r = await apiSend(s, 'POST', '/api/problems', {
    id,
    title,
    blocks: [{ id: crypto.randomUUID(), kind: 'markdown', body: `${title} 的题干` }],
    ...extra,
  });
  expect(r.status).toBe(201);
  return id;
}

const rows = (page: Page) => page.getByTestId('list-item');

test('导航树按标签子树筛选；Shift 连选后批量加标签并可撤销', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  await seed(server, '单调性一', { tags: ['数学/函数/单调性'], subject: '数学' });
  await seed(server, '几何一', { tags: ['数学/几何'], subject: '数学' });
  await seed(server, '受力分析', { tags: ['物理'], subject: '物理' });
  await seed(server, '未分类');

  await page.goto(`${server.url}/problems`);
  await expect(rows(page)).toHaveCount(4);
  const tree = page.getByRole('tree', { name: '题目标签树' });
  // 父节点计数包含子树
  await expect(tree.getByRole('treeitem', { name: '数学' })).toContainText('2');
  await tree.getByRole('treeitem', { name: '数学' }).click();
  await expect(page).toHaveURL(/tag=/);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId('result-count')).toContainText('共 2 项（已筛选）');
  // 再点一次取消筛选
  await tree.getByRole('treeitem', { name: '数学' }).click();
  await expect(rows(page)).toHaveCount(4);
  await tree.getByRole('treeitem', { name: '无标签' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('未分类');
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(rows(page)).toHaveCount(4);

  // 勾选第 1 项，Shift+勾选第 3 项 → 连选 3 项
  await rows(page).nth(0).getByRole('checkbox').click();
  await rows(page).nth(2).getByRole('checkbox').click({ modifiers: ['Shift'] });
  const bar = page.getByTestId('batch-bar');
  await expect(bar).toContainText('已选 3 项');
  await bar.getByRole('button', { name: '加标签' }).click();
  await page.getByLabel('搜索或新建标签').fill('待讲评');
  await page.getByRole('option', { name: /新建并添加“待讲评”/ }).click();
  await expect(page.getByText('已加上“待讲评”：3 项')).toBeVisible();
  await expect.poll(async () => (await apiGet(server!, `/api/problems?tag=${encodeURIComponent('待讲评')}`)).total).toBe(3);
  // 撤销
  await page.getByRole('button', { name: '撤销' }).click();
  await expect.poll(async () => (await apiGet(server!, `/api/problems?tag=${encodeURIComponent('待讲评')}`)).total).toBe(0);
});

test('批量设学科、移到回收站；键盘多选与快速预览；命令面板跳转', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const a = await seed(server, '第一题', { notes: [{ id: crypto.randomUUID(), type: 'answer', bodyMd: '答案是 $42$' }] });
  await seed(server, '第二题');
  await seed(server, '第三题');

  await page.goto(`${server.url}/problems`);
  await expect(rows(page)).toHaveCount(3);
  // 键盘：j 移到第一行，空格快速预览（含答案）
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press(' ');
  const look = page.getByTestId('quick-look');
  await expect(look).toContainText('第一题 的题干');
  await expect(look).toContainText('答案');
  await page.keyboard.press('Escape');
  await expect(look).toHaveCount(0);
  // Ctrl+A 全选已加载的项，批量设学科
  await page.keyboard.press('Control+a');
  const bar = page.getByTestId('batch-bar');
  await expect(bar).toContainText('已选 3 项');
  await bar.getByRole('button', { name: '设学科' }).click();
  await page.getByRole('menuitem', { name: '数学' }).click();
  await expect.poll(async () => (await apiGet(server!, `/api/problems?subject=${encodeURIComponent('数学')}`)).total).toBe(3);
  // 导航树出现学科节点
  await expect(page.getByRole('tree', { name: '学科筛选树' }).getByRole('treeitem', { name: '数学' })).toContainText('3');
  // Esc 取消选择；x 选中当前行后移到回收站（确认对话框）
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await page.keyboard.press('x');
  await page.getByTestId('batch-bar').getByRole('button', { name: '移到回收站' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(rows(page)).toHaveCount(2);
  expect((await apiGet(server, `/api/problems/${a}`)).deletedAt).not.toBeNull();

  // 命令面板：Ctrl+K，按关键词跳转
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('第二');
  await page.getByRole('option', { name: /第二题/ }).first().click();
  await expect(page.getByTestId('problem-editor')).toBeVisible();
  await expect(page.getByLabel('标题（可选）')).toHaveValue('第二题');
});

test('数据管理：标签改名同步到题目；批量操作后陈旧编辑页保存得到冲突', async ({ page, browser }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const id = await seed(server, '换元题', { tags: ['方法/换元'] });

  // 另一个浏览器上下文里先打开编辑页（收不到本浏览器的通知，模拟陈旧页面）
  const other = await browser.newContext();
  const stale = await other.newPage();
  await stale.goto(`${server.url}/problems/${id}`);
  await expect(stale.getByTestId('problem-editor')).toBeVisible();

  await page.goto(`${server.url}/manage?tab=tags`);
  const list = page.getByRole('list', { name: '标签树' });
  await expect(list).toContainText('换元');
  await list.getByRole('listitem').filter({ hasText: '方法/换元' }).getByRole('button', { name: '改名/移动' }).click();
  await page.getByLabel('标签新路径').fill('技巧/换元法');
  await page.getByLabel('标签新路径').press('Enter');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByText(/已改名 1 个/)).toBeVisible();
  expect((await apiGet(server, `/api/problems/${id}`)).tags).toEqual(['技巧/换元法']);

  // 陈旧页面带着旧标签保存：得到冲突，旧标签不会写回
  await stale.getByLabel('标题（可选）').fill('陈旧页面的标题');
  await stale.getByTestId('save-button').click();
  await expect(stale.getByRole('dialog', { name: '保存冲突' })).toBeVisible();
  expect((await apiGet(server, `/api/problems/${id}`)).tags).toEqual(['技巧/换元法']);
  await other.close();
});
