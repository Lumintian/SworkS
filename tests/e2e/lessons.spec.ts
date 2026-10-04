/** 教案：列表里勾选题目组成教案 → 调整顺序、写讲解要点、展开看题 → 搜索加题 → 题目页看到“用在这些教案里”。 */
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
  return (await res.json()) as any;
}

const itemTitles = (page: Page) => page.getByTestId('lesson-item-title');

test('勾选题目组成教案 → 重排并保存 → 搜索加题 → 题目页列出所在教案', async ({ page }) => {
  server = await startServer(path.join(tempDir(), 'data'));
  const ids: Record<string, string> = {};
  for (const title of ['二次函数最值', '数列通项', '立体几何体积']) {
    const id = crypto.randomUUID();
    await apiSend(server, 'POST', '/api/problems', {
      id,
      title,
      blocks: [{ id: crypto.randomUUID(), kind: 'markdown', body: `${title}的题干` }],
      notes: [{ id: crypto.randomUUID(), type: 'answer', bodyMd: `${title}的答案` }],
    });
    ids[title] = id;
  }
  const before = await apiGet(server, `/api/problems/${ids['二次函数最值']}`);

  // 1. 按勾选顺序组成教案
  await page.goto(`${server.url}/problems`);
  await page.getByRole('checkbox', { name: '选择 立体几何体积' }).check();
  await page.getByRole('checkbox', { name: '选择 二次函数最值' }).check();
  await page.getByTestId('batch-lesson').click();
  await page.getByRole('menuitem', { name: /新建教案（2 道题/ }).click();
  await expect(page.getByTestId('lesson-editor')).toBeVisible();
  await expect(itemTitles(page)).toHaveText(['立体几何体积', '二次函数最值']);

  // 2. 标题、键盘拖动重排、讲解要点，保存
  await page.getByLabel('教案标题').fill('函数与几何 · 第一讲');
  const handle = page.getByRole('button', { name: '拖动排序：第 2 题（共 2 题）' });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: '移到第 2 题的位置' })).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('status').filter({ hasText: '移到第 1 题的位置' })).toHaveCount(1);
  await page.keyboard.press('Space');
  await expect(itemTitles(page)).toHaveText(['二次函数最值', '立体几何体积']);
  await page.getByLabel('第 1 题的讲解要点').fill('从配方引入');
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('saved-indicator')).toBeVisible();
  const lessonId = new URL(page.url()).pathname.split('/').pop()!;
  const saved = await apiGet(server, `/api/lessons/${lessonId}`);
  expect(saved.items.map((i: any) => [i.problemId, i.note])).toEqual([
    [ids['二次函数最值'], '从配方引入'],
    [ids['立体几何体积'], null],
  ]);
  // 组教案不改变题目本身
  expect((await apiGet(server, `/api/problems/${ids['二次函数最值']}`)).version).toBe(before.version);

  // 3. 展开看题目当前的内容（含答案）
  await page.getByRole('button', { name: '全部展开' }).click();
  await expect(page.getByTestId('lesson-item-preview').first()).toContainText('二次函数最值的题干');

  // 4. 搜索加题，再保存
  await page.getByTestId('lesson-add-problem').click();
  await page.getByTestId('lesson-picker-input').fill('数列');
  await page.getByTestId('lesson-picker-item').filter({ hasText: '数列通项' }).click();
  await page.keyboard.press('Escape');
  await expect(itemTitles(page)).toHaveText(['二次函数最值', '立体几何体积', '数列通项']);
  await expect(page.getByTestId('save-status')).toContainText('有未保存的修改');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('saved-indicator')).toBeVisible();
  expect((await apiGet(server, `/api/lessons/${lessonId}`)).items).toHaveLength(3);

  // 别处把教案里的一道题移到回收站：教案页即时标出，引用保留，页面仍是已保存状态
  await apiSend(server, 'DELETE', `/api/problems/${ids['立体几何体积']}`, undefined);
  await expect(page.getByTestId('lesson-item').filter({ hasText: '立体几何体积' })).toContainText('题目在回收站');
  await expect(page.getByTestId('save-button')).toBeDisabled();

  // 5. 题目页列出所在教案；教案列表有这份教案
  await page.goto(`${server.url}/problems/${ids['数列通项']}`);
  await expect(page.getByTestId('problem-lessons')).toContainText('函数与几何 · 第一讲');
  await page.getByTestId('problem-lessons').getByRole('link', { name: '函数与几何 · 第一讲' }).click();
  await expect(page.getByTestId('lesson-editor')).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: /教案/ }).click();
  await expect(page.getByTestId('lesson-card')).toHaveCount(1);
  await expect(page.getByTestId('lesson-card')).toContainText('3 道题');
});
