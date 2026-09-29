/** 数据管理的多选与右键菜单：标签树、学科列表、选项树、属性列表。 */
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiGet, startServer, tempDir, type Server } from './helpers';

let server: Server | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function seed(s: Server, title: string, extra: Record<string, unknown> = {}) {
  const session = (await apiGet(s, '/api/session')) as { csrfToken: string };
  const id = crypto.randomUUID();
  const res = await fetch(`${s.url}/api/problems`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sworks-csrf': session.csrfToken, origin: s.url },
    body: JSON.stringify({ id, title, blocks: [{ id: crypto.randomUUID(), kind: 'markdown', body: `${title} 的题干` }], ...extra }),
  });
  expect(res.status).toBe(201);
  return id;
}

test('标签树：⌘ 点选两个标签 → 右键 → 删除 2 个标签', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const a = await seed(server, '甲', { tags: ['函数', '几何/圆'] });
  const b = await seed(server, '乙', { tags: ['几何/三角形', '数列'] });

  await page.goto(`${server.url}/manage?tab=tags`);
  const tree = page.getByRole('tree', { name: '标签树', exact: true });
  const item = (name: string) => tree.getByRole('treeitem', { name, exact: true });
  await item('函数').click();
  await item('几何').click({ modifiers: ['ControlOrMeta'] });
  await expect(item('函数')).toHaveAttribute('aria-selected', 'true');
  await expect(item('几何')).toHaveAttribute('aria-selected', 'true');

  await item('几何').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除 2 个标签' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByText(/已删除 \d+ 个标签，影响 2 项/)).toBeVisible();
  await expect(item('函数')).toHaveCount(0);
  await expect(item('几何')).toHaveCount(0);
  await expect(item('数列')).toHaveCount(1);
  expect((await apiGet(server, `/api/problems/${a}`)).tags).toEqual([]);
  expect((await apiGet(server, `/api/problems/${b}`)).tags).toEqual(['数列']);
});

test('学科列表：⇧ 连选三个值 → 右键 → 从所有对象上清除', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const ids = [await seed(server, '一', { subject: '数学' }), await seed(server, '二', { subject: '物理' }), await seed(server, '三', { subject: '化学' })];
  const keep = await seed(server, '四', { subject: '生物' });

  await page.goto(`${server.url}/manage?tab=subject`);
  const tree = page.getByRole('tree', { name: '学科列表', exact: true });
  const item = (name: string) => tree.getByRole('treeitem', { name, exact: true });
  // 候选按默认顺序：数学、物理、化学、生物……
  await item('数学').click();
  await item('化学').click({ modifiers: ['Shift'] });
  for (const n of ['数学', '物理', '化学']) await expect(item(n)).toHaveAttribute('aria-selected', 'true');
  await expect(item('生物')).toHaveAttribute('aria-selected', 'false');

  await item('物理').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '从所有对象上清除 3 项' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByText(/已清除，影响 3 项/)).toBeVisible();
  for (const id of ids) expect((await apiGet(server, `/api/problems/${id}`)).subject).toBeNull();
  expect((await apiGet(server, `/api/problems/${keep}`)).subject).toBe('生物');
});

test('选项树多选删除；属性列表右键菜单', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const defs = (await apiGet(server, '/api/properties')) as { id: string; preset: string; name: string; options: { id: string; path: string }[] }[];
  const qt = defs.find((d) => d.preset === 'qtype')!;
  const opt = (p: string) => qt.options.find((o) => o.path === p)!.id;
  const id = await seed(server, '选择题', { properties: [{ propertyId: qt.id, optionIds: [opt('单选')] }] });
  const before = (await apiGet(server, `/api/problems/${id}`)).version;

  await page.goto(`${server.url}/manage?tab=properties`);
  const list = page.getByRole('list', { name: '属性列表' });
  // 右键属性 → 编辑选项
  await list.getByRole('listitem').filter({ hasText: qt.name }).first().click({ button: 'right', position: { x: 8, y: 8 } });
  await page.getByRole('menuitem', { name: '编辑选项' }).click();
  const tree = page.getByRole('tree', { name: `${qt.name}选项树` });
  await tree.getByRole('treeitem', { name: '单选', exact: true }).click();
  await tree.getByRole('treeitem', { name: '多选', exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await page.keyboard.press('Delete');
  await page.getByTestId('confirm-ok').click();
  await expect(tree.getByRole('treeitem', { name: '单选', exact: true })).toHaveCount(0);
  await expect(tree.getByRole('treeitem', { name: '多选', exact: true })).toHaveCount(0);
  await expect(tree.getByRole('treeitem', { name: '填空', exact: true })).toHaveCount(1);
  const after = await apiGet(server, `/api/problems/${id}`);
  expect(after.properties).toEqual([]);
  expect(after.version).toBe(before + 1);

  // 右键 → 改名
  await list.getByRole('listitem').filter({ hasText: '难度' }).first().click({ button: 'right', position: { x: 8, y: 8 } });
  await page.getByRole('menuitem', { name: '改名' }).click();
  await page.getByLabel('属性新名称').fill('难易度');
  await page.getByLabel('属性新名称').press('Enter');
  await expect(list).toContainText('难易度');
});
