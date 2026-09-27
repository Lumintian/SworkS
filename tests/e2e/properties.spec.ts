/** 属性与考点树：大纲导入、编辑页设置难度与考点、导航筛选、按难度排序、批量设置。 */
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiGet, pasteText, saveAndWait, startServer, tempDir, type Server } from './helpers';

let server: Server | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test('导入考点大纲 → 编辑页设难度与考点 → 导航按考点子树筛选 → 按难度排序 → 批量设难度', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const defs = (await apiGet(server, '/api/properties')) as { id: string; preset: string }[];
  const kp = defs.find((d) => d.preset === 'knowledge')!;
  const diff = defs.find((d) => d.preset === 'difficulty')!;

  // 1. 数据管理：导入考点大纲
  await page.goto(`${server.url}/manage?tab=properties`);
  await page.getByRole('list', { name: '属性列表' }).getByRole('button', { name: /^考点/ }).click();
  await page.getByRole('button', { name: '导入大纲' }).click();
  await page.getByLabel('大纲内容').fill('# 函数\n- 单调性\n- 奇偶性\n# 数列');
  await page.getByRole('dialog', { name: '导入考点大纲' }).getByRole('button', { name: '导入' }).click();
  await expect(page.getByText('已新建 4 个选项')).toBeVisible();
  const tree = page.getByRole('tree', { name: '考点选项树' });
  await expect(tree.getByRole('treeitem', { name: '函数' })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: '数列' })).toBeVisible();

  // 2. 编辑页：设置难度（分段按钮）与考点（选择器，含子级）
  await page.getByTestId('new-problem').click();
  await page.getByTestId('paste-zone').focus();
  await pasteText(page, '[data-testid="paste-zone"]', '判断函数 f(x)=x^3 的单调性');
  await expect(page.getByTestId('content-block')).toHaveCount(1);
  const editor = page.getByTestId('problem-editor');
  await editor.getByRole('group', { name: '难度' }).getByRole('button', { name: '较难' }).click();
  await editor.getByRole('button', { name: '选择考点' }).click();
  await page.getByRole('combobox', { name: '选择考点' }).fill('单调');
  await page.getByRole('option', { name: /单调性/ }).click();
  await page.keyboard.press('Escape');
  await expect(editor.getByRole('group', { name: '考点' })).toContainText('单调性');
  await saveAndWait(page);
  const id = page.url().split('/').pop()!;
  const saved = await apiGet(server, `/api/problems/${id}`);
  expect(saved.properties.map((p: { propertyId: string }) => p.propertyId).sort()).toEqual([diff.id, kp.id].sort());

  // 再建一道“容易”的题，一道不设难度的题
  for (const [text, level] of [
    ['数列求和', '容易'],
    ['没有难度的题', null],
  ] as const) {
    await page.getByTestId('new-problem').click();
    await page.getByTestId('paste-zone').focus();
    await pasteText(page, '[data-testid="paste-zone"]', text);
    await expect(page.getByTestId('content-block')).toHaveCount(1);
    if (level) await page.getByTestId('problem-editor').getByRole('group', { name: '难度' }).getByRole('button', { name: level }).click();
    await saveAndWait(page);
  }

  // 3. 列表：导航“考点”树按子树筛选（点“函数”包含“单调性”）
  await page.goto(`${server.url}/problems`);
  const kpTree = page.getByRole('tree', { name: '考点筛选树' });
  await kpTree.getByRole('treeitem', { name: '函数' }).click();
  await expect(page.getByTestId('list-item')).toHaveCount(1);
  await expect(page.getByTestId('list-item')).toContainText('单调性');
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByTestId('list-item')).toHaveCount(3);

  // 4. 按难度排序：容易 → 较难 → 未设置
  await page.getByRole('group', { name: '排序' }).getByRole('button', { name: '按难度' }).click();
  await expect(page.getByTestId('list-item').nth(0)).toContainText('数列求和');
  await expect(page.getByTestId('list-item').nth(1)).toContainText('单调性');
  await expect(page.getByTestId('list-item').nth(2)).toContainText('没有难度的题');

  // 5. 批量设难度
  await page.getByRole('checkbox', { name: '全选已加载的项' }).check();
  await page.getByTestId('batch-bar').getByRole('button', { name: '设属性' }).click();
  await page.getByRole('menuitem', { name: /难度/ }).click();
  await page.getByRole('option', { name: '中档' }).click();
  await expect(page.getByText(/已设置难度为“中档”/)).toBeVisible();
  const list = await apiGet(server, `/api/problems?prop=${diff.id}:__none__`);
  expect(list.total).toBe(0);
});
