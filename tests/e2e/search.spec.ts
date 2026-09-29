/** 检索语言：补全、条件面板与文本同步、常用检索、命中片段高亮。 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiGet, startServer, tempDir, type Server } from './helpers';

let server: Server | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function seed(s: Server, title: string, body: string, extra: Record<string, unknown> = {}) {
  const session = (await apiGet(s, '/api/session')) as { csrfToken: string };
  const res = await fetch(`${s.url}/api/problems`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sworks-csrf': session.csrfToken, origin: s.url },
    body: JSON.stringify({ id: crypto.randomUUID(), title, blocks: [{ id: crypto.randomUUID(), kind: 'markdown', body }], ...extra }),
  });
  expect(res.status).toBe(201);
}

const rows = (page: Page) => page.getByTestId('list-item');
const input = (page: Page) => page.getByTestId('search-input');

test('补全选值后过滤；条件面板与文本双向同步；保存为常用检索并从导航打开；命中片段高亮', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  await seed(server, '二次函数', '求二次函数 y=x² 的最值', { subject: '数学', tags: ['函数'] });
  await seed(server, '受力分析', '小球沿斜面下滑', { subject: '物理' });
  await seed(server, '三角形', '求三角形面积', { subject: '数学' });
  await page.goto(`${server.url}/problems`);
  await expect(rows(page)).toHaveCount(3);

  // 1. 补全：键名 → 取值
  await input(page).click();
  await page.keyboard.type('学科');
  const listbox = page.locator('.cm-tooltip-autocomplete');
  await expect(listbox.getByRole('option', { name: /^学科:/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveText('学科:');
  await page.keyboard.type('物');
  await listbox.getByRole('option', { name: '物理' }).click();
  await expect(input(page)).toHaveText('学科:物理');
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('受力分析');
  await expect(page).toHaveURL(/q=/);

  // 2. 面板 → 文本：把“是”改成“不是”
  await page.getByTestId('condition-panel-toggle').click();
  const panel = page.getByTestId('condition-panel');
  const row = panel.getByTestId('condition-row').first();
  await expect(row.getByLabel('字段')).toHaveValue('subject');
  await row.getByLabel('是否取反').selectOption('not');
  await expect(input(page)).toHaveText('-学科:物理');
  await expect(rows(page)).toHaveCount(2);

  // 文本 → 面板：输入框里再加一个条件，面板多出一行
  await input(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' #函数');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId('condition-panel-toggle').click();
  await expect(panel.getByTestId('condition-row')).toHaveCount(2);

  // 3. 保存为常用检索 → 导航里出现（带计数）→ 清除后从导航打开
  await panel.getByLabel('常用检索名称').fill('非物理的函数题');
  await panel.getByRole('button', { name: '保存为常用检索' }).click();
  await expect(page.getByText('已保存为常用检索“非物理的函数题”')).toBeVisible();
  await page.keyboard.press('Escape');
  const saved = page.getByRole('list', { name: '常用检索' }).getByRole('button', { name: /非物理的函数题/ });
  await expect(saved).toContainText('1');
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(rows(page)).toHaveCount(3);
  await saved.click();
  await expect(input(page)).toHaveText('-学科:物理 #函数');
  await expect(rows(page)).toHaveCount(1);

  // 4. 自由词：按相关度，命中片段里用 <mark> 标出
  await page.getByRole('button', { name: '清除筛选' }).click();
  await input(page).click();
  await page.keyboard.type('最值');
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole('group', { name: '排序' }).getByRole('button', { name: '相关度' })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page).first().locator('mark.hit')).toHaveText('最值');

  // 5. 无法识别的选项：没有结果并给出提示
  await input(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('题型:不存在的题型');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('query-diagnostics')).toContainText('没有选项');
  await expect(rows(page)).toHaveCount(0);
});

test('旧书签的筛选参数自动转成查询文本', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  await seed(server, '二次函数', '最值', { subject: '数学', tags: ['函数'] });
  await seed(server, '三角形', '面积', { subject: '数学' });
  await page.goto(`${server.url}/problems?tag=${encodeURIComponent('函数')}&subject=${encodeURIComponent('数学')}`);
  await expect(input(page)).toHaveText('学科:数学 #函数');
  await expect(page).not.toHaveURL(/tag=/);
  await expect(rows(page)).toHaveCount(1);
});
