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

test('标签：移到顶层会合并同名标签时先确认；提示里的“撤销”把两个标签换回来', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const a = await seed(server, '甲', { tags: ['几何/圆'] });
  const b = await seed(server, '乙', { tags: ['圆'] });

  await page.goto(`${server.url}/manage?tab=tags`);
  const tree = page.getByRole('tree', { name: '标签树', exact: true });
  // 两个“圆”：“几何”下的排在前面，顶层的在后面
  await tree.getByRole('treeitem', { name: '圆', exact: true }).nth(0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移到顶层' }).click();
  await expect(page.getByRole('heading', { name: '移动后会合并同名标签' })).toBeVisible();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByText(/已移动：改名 0 个、合并 1 个标签，影响 1 项/)).toBeVisible();
  expect((await apiGet(server, `/api/problems/${a}`)).tags).toEqual(['圆']);

  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByText('已撤销，影响 1 项')).toBeVisible();
  expect((await apiGet(server, `/api/problems/${a}`)).tags).toEqual(['几何/圆']);
  expect((await apiGet(server, `/api/problems/${b}`)).tags).toEqual(['圆']);
});

test('选项树：显示使用次数；按路径过滤后 ⌘/Ctrl+A 只选匹配项；大纲导入先预览', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const defs = (await apiGet(server, '/api/properties')) as { id: string; preset: string; name: string }[];
  const kp = defs.find((d) => d.preset === 'knowledge')!;

  await page.goto(`${server.url}/manage?tab=properties`);
  await page.getByRole('button', { name: '导入大纲' }).click();
  await page.getByLabel('大纲内容').fill('# 函数\n- 单调性\n- 奇偶性\n# 数列\n- 单调数列');
  const preview = page.getByRole('region', { name: '导入预览' });
  await expect(preview).toContainText('将新建 5 个');
  await page.getByRole('button', { name: '导入（新建 5 个）' }).click();

  const opts = (await apiGet(server, `/api/properties/${kp.id}`)).options as { id: string; path: string }[];
  await seed(server, '用到单调性', { properties: [{ propertyId: kp.id, optionIds: [opts.find((o) => o.path === '函数/单调性')!.id] }] });
  const tree = page.getByRole('tree', { name: `${kp.name}选项树` });
  await expect(tree.getByRole('treeitem', { name: '函数', exact: true })).toContainText('1 道题');

  await page.getByLabel(`过滤${kp.name}选项树`).fill('单调');
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
  await tree.getByRole('treeitem', { name: '单调性', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(tree.getByRole('treeitem', { name: '单调性', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(tree.getByRole('treeitem', { name: '单调数列', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(tree.getByRole('treeitem', { name: '函数', exact: true })).toHaveAttribute('aria-selected', 'false');
});

test('学科：只差全角半角的值提示合并；只有回收站里在用的值可以清除', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const a = await seed(server, '一', { subject: 'IB数学' });
  const b = await seed(server, '二', { subject: 'ＩＢ数学' });
  const gone = await seed(server, '三', { subject: '天文' });
  const session = (await apiGet(server, '/api/session')) as { csrfToken: string };
  await fetch(`${server.url}/api/problems/${gone}`, { method: 'DELETE', headers: { 'x-sworks-csrf': session.csrfToken, origin: server.url } });

  await page.goto(`${server.url}/manage?tab=subject`);
  const hint = page.getByRole('note', { name: '疑似重复' });
  await expect(hint).toContainText('1 组名称疑似重复');
  await hint.getByRole('button', { name: /合并为/ }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByText(/已合并，影响 1 项/)).toBeVisible();
  expect((await apiGet(server, `/api/problems/${b}`)).subject).toBe((await apiGet(server, `/api/problems/${a}`)).subject);

  const tree = page.getByRole('tree', { name: '学科列表', exact: true });
  const item = tree.getByRole('treeitem', { name: '天文', exact: true });
  await expect(item).toContainText('回收站中 1 项');
  await item.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '从所有对象上清除' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByText(/已清除，影响 1 项/)).toBeVisible();
  await expect(item).toHaveCount(0);
});

test('属性：第一次建下级时说明“分层”的后果；左侧栏标题右键可以不再列出', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const defs = (await apiGet(server, '/api/properties')) as { id: string; preset: string; name: string; nested: boolean; options: { id: string; path: string }[] }[];
  const diff = defs.find((d) => d.preset === 'difficulty')!;
  expect(diff.nested).toBe(false);
  // 左侧栏只列出有题目在用的属性
  await seed(server, '一道题', { properties: [{ propertyId: diff.id, optionIds: [diff.options.find((o) => o.path === '中档')!.id] }] });

  await page.goto(`${server.url}/manage?item=${diff.id}`);
  const tree = page.getByRole('tree', { name: `${diff.name}选项树` });
  await tree.getByRole('treeitem', { name: '较难', exact: true }).click();
  await page.getByRole('button', { name: '新建下级' }).click();
  await expect(page.getByRole('heading', { name: `让“${diff.name}”的选项可以有下级` })).toBeVisible();
  await page.getByTestId('confirm-ok').click();
  await page.getByLabel('新选项名称').fill('压轴');
  await page.getByLabel('新选项名称').press('Enter');
  await expect(tree.getByRole('treeitem', { name: '压轴', exact: true })).toBeVisible();
  const after = (await apiGet(server, `/api/properties/${diff.id}`)) as { nested: boolean; options: { path: string }[] };
  expect(after.nested).toBe(true);
  expect(after.options.map((o) => o.path)).toContain('较难/压轴');
  await expect(page.getByRole('button', { name: '改为不分层' })).toBeDisabled();

  // 左侧栏：属性标题右键 → 不在左侧栏列出（提示里可撤销）
  await page.goto(`${server.url}/problems`);
  await page.getByRole('button', { name: diff.name, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '不在左侧栏列出' }).click();
  await expect(page.getByText(`左侧栏不再列出“${diff.name}”`)).toBeVisible();
  expect(((await apiGet(server, `/api/properties/${diff.id}`)) as { showInNav: boolean }).showInNav).toBe(false);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => ((await apiGet(server!, `/api/properties/${diff.id}`)) as { showInNav: boolean }).showInNav).toBe(true);
});
